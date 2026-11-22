import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { io } from 'socket.io-client';
import { z } from 'zod';
import {
  identitySchema, listSummarySchema, snapshotSchema, inviteSchema, changeSchema, quantitySchema,
  units, type Alternative, type Identity, type Item, type Quantity, type Snapshot,
} from '@kart/contracts';
import { api, ApiError, setCsrf } from './api';

const ok = z.object({ ok: z.boolean() });
const idResponse = z.object({ id: z.string() });
type Run = (action: () => Promise<unknown>) => Promise<boolean>;
export function App() {
  const client = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [starting, setStarting] = useState(true);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [online, setOnline] = useState(navigator.onLine);
  const [connected, setConnected] = useState(false);
  const [joinCode, setJoinCode] = useState(() => {
    const code = new URLSearchParams(location.hash.slice(1)).get('code') ?? '';
    if (location.hash) history.replaceState(null, '', location.pathname);
    return code;
  });
  const listId = location.pathname.startsWith('/lists/') ? location.pathname.split('/')[2] : undefined;
  const activeList = useRef(listId);
  activeList.current = listId;
  function login(value: Identity) { setCsrf(value.csrfToken); setIdentity(value); client.clear(); }
  useEffect(() => {
    let active = true;
    void api('/auth/me', identitySchema).then(value => {
      if (active) { setCsrf(value.csrfToken); setIdentity(value); }
    }).catch(error => {
      if (active && (!(error instanceof ApiError) || error.status !== 401)) setError(String(error.message));
    }).finally(() => { if (active) setStarting(false); });
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update); window.addEventListener('offline', update);
    return () => { active = false; window.removeEventListener('online', update); window.removeEventListener('offline', update); };
  }, []);
  const lists = useQuery({
    queryKey: ['lists', identity?.id], queryFn: () => api('/lists', z.array(listSummarySchema)), enabled: !!identity,
  });
  const snapshot = useQuery({
    queryKey: ['list', listId], enabled: !!identity && !!listId,
    queryFn: async () => {
      const fresh = await api(`/lists/${listId}`, snapshotSchema);
      const previous = client.getQueryData<Snapshot>(['list', listId]);
      return previous && previous.revision > fresh.revision ? previous : fresh;
    },
  });
  useEffect(() => {
    if (!identity) return;
    const socket = io({ withCredentials: true });
    const refresh = () => {
      void client.invalidateQueries({ queryKey: ['lists'] });
      if (activeList.current) void client.invalidateQueries({ queryKey: ['list', activeList.current] });
    };
    socket.on('connect', () => {
      setConnected(true);
      setError(previous => previous === 'Live connection unavailable. Reconnecting...' ? '' : previous);
      if (listId) socket.emit('subscribe', listId, (reply: { ok: boolean }) => {
        if (!reply.ok) { setError('List access was removed or the list no longer exists.'); refresh(); }
      });
      refresh();
    });
    socket.on('disconnect', () => setConnected(false));
    socket.on('connect_error', () => { setConnected(false); setError('Live connection unavailable. Reconnecting...'); });
    socket.on('list.changed', (data: unknown) => {
      const change = changeSchema.safeParse(data);
      if (change.success && change.data.listId === activeList.current) {
        const old = client.getQueryData<Snapshot>(['list', change.data.listId]);
        if (!old || old.revision < change.data.revision) refresh();
      }
    });
    socket.on('permissions.changed', refresh);
    socket.on('session.revoked', () => {
      setIdentity(null); setCsrf(); client.clear(); setError('Your session ended. Please sign in again.');
    });
    const interval = window.setInterval(() => {
      if (activeList.current && navigator.onLine) void api(`/lists/${activeList.current}/revision`, z.object({ revision: z.number() }))
        .then(value => {
          const current = client.getQueryData<Snapshot>(['list', activeList.current]);
          if (current?.revision !== value.revision) refresh();
        }).catch(error => setError(error.message));
    }, 30_000);
    return () => { socket.disconnect(); window.clearInterval(interval); setConnected(false); };
  }, [identity?.id, listId, client]);

  const run: Run = async action => {
    setPending(true); setError('');
    try {
      await action();
      await Promise.all([
        client.invalidateQueries({ queryKey: ['lists'] }),
        client.invalidateQueries({ queryKey: ['list', listId] }),
      ]);
      return true;
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Request failed.');
      if (error instanceof ApiError && error.status === 409) await client.invalidateQueries({ queryKey: ['list', listId] });
      if (error instanceof ApiError && error.status === 401) { setIdentity(null); setCsrf(); client.clear(); }
      return false;
    } finally { setPending(false); }
  };
  const disabled = pending || !online || (!!identity && !connected);
  const dataError = lists.error ?? snapshot.error;
  return <div className="shell">
    <header className="topbar"><Link to="/" className="brand"><img src="/icon.svg" alt="" />kart<span>shop together</span></Link>
      {identity && <div className="account"><span>{identity.name}</span><button className="quiet" disabled={pending || !online}
        onClick={() => void run(async () => { await api('/auth/logout', ok, { method: 'POST' }); setIdentity(null); setCsrf(); client.clear(); navigate('/'); })}>Sign out</button></div>}
    </header>
    <main>
      <div className="eyebrow">LESS BACK-AND-FORTH. MORE TOGETHER.</div>
      {starting ? <p role="status">Opening your Kart...</p> : !identity ? <section className="welcome card">
        <h1>One list.<br />Everyone in sync.</h1><p>Add what you need. See what is bought. Keep your next grocery run a little calmer.</p>
        <button disabled={pending || !online} onClick={() => void run(async () => login(await api('/auth/guest', identitySchema, { method: 'POST' })))}>Try as a guest</button>
        <a className="button secondary" href="/api/auth/google">Continue with Google</a>
        <p className="muted">Guest lists stay tied to this browser session. Upgrade before sharing or clearing browser data.</p>
      </section> : <>
        <div className="connection" role="status"><span className={connected && online ? 'dot' : 'dot offline'} />{!online ? 'Offline - reconnect to edit' : connected ? 'Live and connected' : 'Reconnecting - editing paused'}</div>
        {identity.kind === 'guest' && <aside className="notice">You are a guest. Clearing browser data or session expiry can lose access.
          {identity.googleEnabled ? <a href="/api/auth/google"> Save with Google</a> : <span> Google sign-in is not configured on this server yet.</span>}</aside>}
        <div className="workspace">
          <aside className="sidebar card">
            <h2>Your lists</h2><nav aria-label="Shopping lists">{lists.data?.map(list => <Link className={list.id === listId ? 'selected' : ''} key={list.id} to={`/lists/${list.id}`}>{list.title}<small>{list.role}</small></Link>)}</nav>
            <form onSubmit={event => {
              event.preventDefault();
              const form = event.currentTarget, title = String(new FormData(form).get('title'));
              void run(async () => { const list = await api('/lists', listSummarySchema, { method: 'POST', body: { title } }); form.reset(); navigate(`/lists/${list.id}`); });
            }}>
              <label>New list name<input name="title" placeholder="Weekly groceries" required maxLength={100} /></label>
              <button disabled={disabled}>Create list</button>
            </form>
            <hr /><h3>Join your family</h3>
            <form onSubmit={event => {
              event.preventDefault();
              void run(async () => {
                const list = await api('/lists/join', listSummarySchema, { method: 'POST', body: { code: joinCode.trim().toUpperCase() } });
                setJoinCode(''); navigate(`/lists/${list.id}`);
              });
            }}><label>12-character code<input value={joinCode} onChange={event => setJoinCode(event.target.value)} autoCapitalize="characters" maxLength={12} required /></label><button className="secondary" disabled={disabled}>Join list</button></form>
          </aside>
          <section className="list-panel">
            {snapshot.isFetching && !snapshot.data && <p role="status">Loading list...</p>}
            {!listId ? <div className="empty card"><h1>A fresh start for your next shop.</h1><p>Create a list or enter a family code to get started.</p><p className="muted">Your lists are private until you choose to share.</p></div>
              : snapshot.data && !snapshot.error ? <ShoppingList key={listId} list={snapshot.data} identity={identity} disabled={disabled} run={run} onDeleted={() => navigate('/')} /> : null}
          </section>
        </div>
        <details className="account-tools"><summary>Privacy and account</summary><p>Kart stores your identity, memberships, and shopping lists. No advertising or analytics is enabled in this pilot.</p>
          <p>Deleting your account permanently removes owned lists for everyone. Backup copies may remain until their documented retention expires.</p>
          <button className="danger" disabled={disabled} onClick={() => {
            if (window.prompt('This deletes all your owned lists for everyone. Type DELETE to confirm.') === 'DELETE') void run(async () => {
              await api('/auth/account', ok, { method: 'DELETE', body: { confirmation: 'DELETE' } }); setIdentity(null); setCsrf(); client.clear(); navigate('/');
            });
          }}>Delete account and owned lists</button></details>
      </>}
      {(error || dataError) && <div className="error" role="alert">{error || (dataError instanceof Error ? dataError.message : 'Could not load data.')}<button className="quiet" onClick={() => { setError(''); void client.invalidateQueries(); }}>Retry / refresh</button></div>}
    </main>
    <footer>Made for real households. No noise. Just your list.</footer>
  </div>;
}

function QuantityForm({ initial, label, disabled, submit }: {
  initial?: Quantity; label: string; disabled: boolean; submit: (value: Quantity, key: string) => Promise<boolean>;
}) {
  const [error, setError] = useState('');
  const retry = useRef<{ payload: string; key: string } | null>(null);
  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget, data = new FormData(form);
    const amount = String(data.get('amount') || '').trim(), unit = String(data.get('unit') || '');
    const value = quantitySchema.safeParse({
      name: data.get('name'), packCount: Number(data.get('packCount')),
      amount: amount || null, unit: unit || null,
    });
    if (!value.success) { setError(value.error.issues.map(issue => issue.message).join(' ')); return; }
    setError('');
    const payload = JSON.stringify(value.data);
    if (retry.current?.payload !== payload) retry.current = { payload, key: crypto.randomUUID() };
    if (await submit(value.data, retry.current.key)) {
      retry.current = null;
      if (!initial) form.reset();
    }
  }
  return <form className="quantity-form" onSubmit={event => void onSubmit(event)}>
    <label className="item-name">Item name<input name="name" defaultValue={initial?.name} placeholder="What do you need?" required maxLength={120} /></label>
    <label>Packs<input name="packCount" type="number" defaultValue={initial?.packCount ?? 1} min={1} max={999} required /></label>
    <label>Amount / pack<input name="amount" type="text" inputMode="decimal" defaultValue={initial?.amount ?? ''} placeholder="Optional" /></label>
    <label>Unit<select name="unit" defaultValue={initial?.unit ?? ''}><option value="">None</option>{units.map(unit => <option key={unit}>{unit}</option>)}</select></label>
    <button disabled={disabled}>{label}</button>{error && <p className="error" role="alert">{error}</p>}
  </form>;
}

function ShoppingList({ list, identity, disabled, run, onDeleted }: {
  list: Snapshot; identity: Identity; disabled: boolean; run: Run; onDeleted: () => void;
}) {
  const base = `/lists/${list.id}`;
  const edit = list.role !== 'viewer';
  const [invite, setInvite] = useState<{ code: string; expiresAt: string }>();
  const [qr, setQr] = useState('');
  const [qrError, setQrError] = useState('');
  const [titleEdit, setTitleEdit] = useState(false);
  const url = invite ? `${window.location.origin}/join#code=${invite.code}` : '';
  useEffect(() => {
    let active = true;
    if (url) void import('qrcode').then(({ default: qrCode }) => qrCode.toDataURL(url, { width: 192, margin: 2 })).then(value => {
      if (active) { setQr(value); setQrError(''); }
    }).catch(() => { if (active) setQrError('QR generation failed. Use the code or link instead.'); });
    return () => { active = false; };
  }, [url]);
  const needed = list.items.filter(item => item.status !== 'purchased'), purchased = list.items.filter(item => item.status === 'purchased');
  return <>
    <div className="list-heading"><div><span className="pill">{list.role}</span><h1>{list.title}</h1><p className="muted">{needed.length} to consider · {purchased.length} purchased</p></div>
      {list.role === 'owner' && <div className="row"><button className="quiet" disabled={disabled} onClick={() => setTitleEdit(!titleEdit)}>Rename</button>
        <button className="quiet danger" disabled={disabled} onClick={() => {
          if (window.confirm('Delete this list for everyone?')) void run(async () => { await api(base, ok, { method: 'DELETE' }); onDeleted(); });
        }}>Delete list</button></div>}
    </div>
    {titleEdit && <form className="row card" onSubmit={event => {
      event.preventDefault(); const title = String(new FormData(event.currentTarget).get('title'));
      void run(async () => { await api(base, ok, { method: 'PATCH', body: { title } }); setTitleEdit(false); });
    }}><label>List title<input name="title" defaultValue={list.title} required maxLength={100} /></label><button disabled={disabled}>Save title</button></form>}
    {edit ? <div className="card add-item"><h2>Add to your list</h2><QuantityForm label="Add item" disabled={disabled}
      submit={(value, key) => run(() => api(`${base}/items`, idResponse, { method: 'POST', body: value, key }))} />
      <p className="muted">Example: 2 packs, 500 ml each. Leave amount and unit empty for simple items.</p></div>
      : <aside className="notice">You can view this list live. Ask its owner for edit access.</aside>}
    <div className="items" aria-label="Needed items">
      {needed.length === 0 && <div className="empty card"><h2>{purchased.length ? 'All checked off.' : 'Room for something good.'}</h2><p>{edit ? 'Add your first item above.' : 'Items will appear here as your family adds them.'}</p></div>}
      {[...needed, ...purchased].flatMap((item, index) => [
        ...(index === needed.length && purchased.length ? [<h2 className="section-title" key="purchased-heading">Purchased <span>{purchased.length}</span></h2>] : []),
        <ItemCard key={item.id} item={item} base={base} disabled={disabled || !edit} editable={edit} run={run} />,
      ])}
    </div>
    {list.role === 'owner' && <details className="card sharing"><summary>Share and manage members</summary>
      <p>Anyone with your code can join as a viewer of this list. Codes expire in seven days. Removing a code does not remove existing members.</p>
      {identity.kind !== 'google' ? <p>Sign in with Google to enable sharing.</p> : <>
        <div className="row"><button disabled={disabled} onClick={() => void run(async () => setInvite(await api(`${base}/invite`, inviteSchema, { method: 'POST' })))}>Generate / rotate code</button>
          <button className="secondary" disabled={disabled} onClick={() => void run(async () => { await api(`${base}/invite`, ok, { method: 'DELETE' }); setInvite(undefined); })}>Revoke code</button></div>
        {invite && <div className="invite"><strong className="code">{invite.code}</strong><p>Expires {new Date(invite.expiresAt).toLocaleString()}</p><label>Join link<input readOnly value={url} onFocus={event => event.target.select()} /></label>
          <button className="secondary" disabled={disabled} onClick={() => void run(async () => { await navigator.clipboard.writeText(url); })}>Copy link</button>
          {qr && <img className="qr" src={qr} alt="QR code to join this shopping list" />}{qrError && <p role="alert">{qrError}</p>}</div>}
      </>}
      <h3>Members</h3>{list.members.length === 0 && <p className="muted">No members yet.</p>}
      {list.members.map(member => <div key={member.userId} className="member"><span>{member.name}</span>
        <label>Access<select value={member.role} disabled={disabled} onChange={event => void run(() => api(`${base}/members/${member.userId}`, ok, { method: 'PATCH', body: { role: event.target.value } }))}><option value="viewer">Viewer</option><option value="editor">Editor</option></select></label>
        <button className="quiet danger" disabled={disabled} onClick={() => {
          if (window.confirm(`Remove ${member.name}'s access?`)) void run(() => api(`${base}/members/${member.userId}`, ok, { method: 'DELETE' }));
        }}>Remove</button></div>)}
    </details>}
  </>;
}

function describe(item: Quantity) {
  const count = `${item.packCount} ${item.packCount === 1 ? 'pack' : 'packs'}`;
  return item.amount && item.unit ? `${count} × ${item.amount} ${item.unit}` : count;
}
function ItemCard({ item, base, disabled, editable, run }: {
  item: Item; base: string; disabled: boolean; editable: boolean; run: Run;
}) {
  const [editing, setEditing] = useState<Item | null>(null);
  const [alternatives, setAlternatives] = useState(false);
  const [editingAlternative, setEditingAlternative] = useState<{ alternative: Alternative; version: number }>();
  const selectionKeys = useRef(new Map<string, string>());
  const path = `${base}/items/${item.id}`;
  const update = (status: Item['status']) => run(() => api(path, ok, {
    method: 'PATCH', body: { name: item.name, packCount: item.packCount, amount: item.amount, unit: item.unit, version: item.version, status },
  }));
  return <article className={`item card ${item.status}`} data-testid={`item-${item.name}`}>
    <div className="item-main">
      <button className="check" aria-label={`${item.status === 'purchased' ? 'Unpurchase' : 'Purchase'} ${item.name}`}
        aria-pressed={item.status === 'purchased'} disabled={disabled} onClick={() => void update(item.status === 'purchased' ? 'needed' : 'purchased')}>{item.status === 'purchased' ? '✓' : ''}</button>
      <div className="item-text"><h3>{item.name}</h3><p>{describe(item)}{item.originalItemId && <span className="pill">Replacement</span>}</p>{item.status === 'unavailable' && <strong className="unavailable-label">Unavailable</strong>}</div>
      {editable && <div className="item-actions"><button className="quiet" disabled={disabled} onClick={() => setEditing(editing ? null : item)}>{editing ? 'Cancel edit' : 'Edit'}</button>
        <button className="quiet" disabled={disabled} onClick={() => void update(item.status === 'unavailable' ? 'needed' : 'unavailable')}>{item.status === 'unavailable' ? 'Available' : 'Unavailable'}</button>
        <button className="quiet danger" disabled={disabled} onClick={() => {
          if (window.confirm(`Remove ${item.name}?`)) void run(() => api(path, ok, { method: 'DELETE', body: { version: item.version } }));
        }}>Delete</button></div>}
    </div>
    {editing && <>
      {editing.version !== item.version && <p className="notice">This item changed. Your draft is preserved. Cancel and reopen the editor to review the latest version.</p>}
      <QuantityForm initial={editing} label="Save item" disabled={disabled} submit={value => run(async () => {
        await api(path, ok, { method: 'PATCH', body: { ...value, status: editing.status, version: editing.version } }); setEditing(null);
      })} />
    </>}
    {(editable || item.status === 'unavailable') && <button className="quiet alternative-toggle" onClick={() => setAlternatives(!alternatives)}>{alternatives ? 'Hide' : 'Manage'} alternatives ({item.alternatives.length})</button>}
    {(alternatives || item.status === 'unavailable') && <div className="alternatives"><h4>Alternatives</h4>
      {item.alternatives.length === 0 && <p className="muted">No alternatives added yet.</p>}
      {item.alternatives.map(alternative => <div className="alternative" key={alternative.id}><div><strong>{alternative.name}</strong><p>{describe(alternative)}</p></div>
        {editable && <div className="row"><button className="quiet" disabled={disabled} onClick={() => setEditingAlternative(editingAlternative?.alternative.id === alternative.id ? undefined : { alternative, version: item.version })}>{editingAlternative?.alternative.id === alternative.id ? 'Cancel alternative edit' : 'Edit alternative'}</button>
        <button className="secondary" disabled={disabled || item.status !== 'unavailable'} onClick={() => {
          let key = selectionKeys.current.get(alternative.id);
          if (!key) { key = crypto.randomUUID(); selectionKeys.current.set(alternative.id, key); }
          void run(() => api(`${path}/select`, idResponse, {
            method: 'POST', body: { alternativeId: alternative.id, version: item.version }, key,
          }));
        }}>Use instead</button><button className="quiet danger" disabled={disabled} onClick={() => void run(() => api(`${path}/alternatives/${alternative.id}`, ok, { method: 'DELETE' }))}>Remove alternative</button></div>}
        {editable && editingAlternative?.alternative.id === alternative.id && <div>
          {editingAlternative.version !== item.version && <p className="notice">This item changed. Cancel and reopen the alternative editor to review the latest version.</p>}
          <QuantityForm initial={editingAlternative.alternative} label="Save alternative" disabled={disabled} submit={value => run(async () => {
            await api(`${path}/alternatives/${alternative.id}`, ok, { method: 'PATCH', body: { ...value, version: editingAlternative.version } }); setEditingAlternative(undefined);
          })} /></div>}</div>)}
      {editable && <QuantityForm label="Add alternative" disabled={disabled} submit={(value, key) => run(() => api(`${path}/alternatives`, idResponse, { method: 'POST', body: value, key }))} />}
    </div>}
  </article>;
}
