-- CreateTable
CREATE TABLE "ProductDraft" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "title" TEXT,
    "category" TEXT,
    "brand" TEXT,
    "collectionId" TEXT,
    "collectionTitle" TEXT,
    "collectionType" TEXT,
    "publishNow" BOOLEAN NOT NULL DEFAULT false,
    "selectedHeights" JSONB,
    "specs" JSONB,
    "accessorySku" TEXT,
    "pdfFileName" TEXT,
    "pdfMimeType" TEXT,
    "pdfSize" INTEGER,
    "pdfDataUrl" TEXT,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductDraft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductDraftImage" (
    "id" TEXT NOT NULL,
    "draftId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "colorName" TEXT NOT NULL,
    "colorSku" TEXT,
    "previewDataUrl" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductDraftImage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OperationLog" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "draftId" TEXT,
    "productId" TEXT,
    "operation" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "userMessage" TEXT,
    "technicalDetail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OperationLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProductDraft_shop_updatedAt_idx" ON "ProductDraft"("shop", "updatedAt");

-- CreateIndex
CREATE INDEX "ProductDraftImage_draftId_position_idx" ON "ProductDraftImage"("draftId", "position");

-- CreateIndex
CREATE INDEX "OperationLog_shop_createdAt_idx" ON "OperationLog"("shop", "createdAt");

-- CreateIndex
CREATE INDEX "OperationLog_draftId_createdAt_idx" ON "OperationLog"("draftId", "createdAt");

-- CreateIndex
CREATE INDEX "OperationLog_productId_createdAt_idx" ON "OperationLog"("productId", "createdAt");

-- AddForeignKey
ALTER TABLE "ProductDraftImage" ADD CONSTRAINT "ProductDraftImage_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "ProductDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;
