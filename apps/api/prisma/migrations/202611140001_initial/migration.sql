-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'guest',
    "name" TEXT NOT NULL DEFAULT 'Guest',
    "googleSubject" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" UUID NOT NULL,
    "digest" TEXT NOT NULL,
    "csrf" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "userId" UUID NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShoppingList" (
    "id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "ownerId" UUID NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShoppingList_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ListMember" (
    "listId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'viewer',

    CONSTRAINT "ListMember_pkey" PRIMARY KEY ("listId","userId")
);

-- CreateTable
CREATE TABLE "ListItem" (
    "id" UUID NOT NULL,
    "listId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "packCount" INTEGER NOT NULL,
    "amount" DECIMAL(9,3),
    "unit" TEXT,
    "status" TEXT NOT NULL DEFAULT 'needed',
    "version" INTEGER NOT NULL DEFAULT 1,
    "lastActorId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "originalItemId" UUID,

    CONSTRAINT "ListItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ItemAlternative" (
    "id" UUID NOT NULL,
    "itemId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "packCount" INTEGER NOT NULL,
    "amount" DECIMAL(9,3),
    "unit" TEXT,

    CONSTRAINT "ItemAlternative_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ListInvite" (
    "id" UUID NOT NULL,
    "digest" TEXT NOT NULL,
    "listId" UUID NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revoked" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ListInvite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WriteKey" (
    "listId" UUID NOT NULL,
    "key" UUID NOT NULL,
    "actorId" UUID NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "itemId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WriteKey_pkey" PRIMARY KEY ("listId","key")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_googleSubject_key" ON "User"("googleSubject");

-- CreateIndex
CREATE UNIQUE INDEX "Session_digest_key" ON "Session"("digest");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE INDEX "ShoppingList_ownerId_idx" ON "ShoppingList"("ownerId");

-- CreateIndex
CREATE INDEX "ListMember_userId_idx" ON "ListMember"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ListItem_originalItemId_key" ON "ListItem"("originalItemId");

-- CreateIndex
CREATE INDEX "ListItem_listId_createdAt_idx" ON "ListItem"("listId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ListInvite_digest_key" ON "ListInvite"("digest");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShoppingList" ADD CONSTRAINT "ShoppingList_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListMember" ADD CONSTRAINT "ListMember_listId_fkey" FOREIGN KEY ("listId") REFERENCES "ShoppingList"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListMember" ADD CONSTRAINT "ListMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListItem" ADD CONSTRAINT "ListItem_listId_fkey" FOREIGN KEY ("listId") REFERENCES "ShoppingList"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListItem" ADD CONSTRAINT "ListItem_originalItemId_fkey" FOREIGN KEY ("originalItemId") REFERENCES "ListItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemAlternative" ADD CONSTRAINT "ItemAlternative_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "ListItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListInvite" ADD CONSTRAINT "ListInvite_listId_fkey" FOREIGN KEY ("listId") REFERENCES "ShoppingList"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WriteKey" ADD CONSTRAINT "WriteKey_listId_fkey" FOREIGN KEY ("listId") REFERENCES "ShoppingList"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "User" ADD CONSTRAINT "User_kind_check" CHECK (
    ("kind" = 'guest' AND "googleSubject" IS NULL) OR ("kind" = 'google' AND "googleSubject" IS NOT NULL)
);
ALTER TABLE "ListMember" ADD CONSTRAINT "ListMember_role_check" CHECK ("role" IN ('editor', 'viewer'));
ALTER TABLE "ListItem" ADD CONSTRAINT "ListItem_quantity_check" CHECK (
    length(trim("name")) BETWEEN 1 AND 120 AND "packCount" BETWEEN 1 AND 999
    AND (("amount" IS NULL AND "unit" IS NULL) OR ("amount" IS NOT NULL AND "unit" IS NOT NULL AND "amount" > 0 AND "unit" IN ('g', 'kg', 'ml', 'l', 'piece')))
);
ALTER TABLE "ItemAlternative" ADD CONSTRAINT "ItemAlternative_quantity_check" CHECK (
    length(trim("name")) BETWEEN 1 AND 120 AND "packCount" BETWEEN 1 AND 999
    AND (("amount" IS NULL AND "unit" IS NULL) OR ("amount" IS NOT NULL AND "unit" IS NOT NULL AND "amount" > 0 AND "unit" IN ('g', 'kg', 'ml', 'l', 'piece')))
);
ALTER TABLE "ListItem" ADD CONSTRAINT "ListItem_status_check" CHECK ("status" IN ('needed', 'purchased', 'unavailable'));
ALTER TABLE "ListItem" ADD CONSTRAINT "ListItem_version_check" CHECK ("version" > 0 AND "originalItemId" IS DISTINCT FROM "id");
ALTER TABLE "ShoppingList" ADD CONSTRAINT "ShoppingList_title_check" CHECK (length(trim("title")) BETWEEN 1 AND 100 AND "revision" >= 0);
