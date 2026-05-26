import {
  generateFilmVariants,
  productCreatorPayloadSchema,
  productSpecsSku,
  summarizeZodError,
  type ProductCreatorPayload,
} from "../../lib/product-creator";
import { logOperation } from "../operation-log.server";
import {
  assertNoUserErrors,
  normalizeShopifyError,
  shopifyGraphql,
  type ShopifyAdminClient,
} from "./common.server";
import { addProductToCollection } from "./collections.server";
import {
  createShopifyFile,
  createShopifyFileFromResourceUrl,
  createShopifyFileFromUpload,
  stagedUploadFile,
  stagedUploadFromDataUrl,
} from "./files.server";
import { createProductSpecEntries } from "./metaobjects.server";
import { getProductMetafieldDefinition, setProductMetafields } from "./metafields.server";

const PRODUCT_CREATE = `#graphql
  mutation GuidedProductCreate($product: ProductCreateInput!, $media: [CreateMediaInput!]) {
    productCreate(product: $product, media: $media) {
      product {
        id
        handle
        title
        status
        media(first: 100) {
          nodes {
            id
            alt
            mediaContentType
            preview {
              status
            }
          }
        }
        variants(first: 10) {
          nodes {
            id
            title
          }
        }
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

const PRODUCT_VARIANTS_BULK_CREATE = `#graphql
  mutation GuidedProductVariantsBulkCreate(
    $productId: ID!
    $variants: [ProductVariantsBulkInput!]!
    $strategy: ProductVariantsBulkCreateStrategy
  ) {
    productVariantsBulkCreate(productId: $productId, variants: $variants, strategy: $strategy) {
      productVariants {
        id
        title
        selectedOptions {
          name
          value
        }
        media(first: 10) {
          nodes {
            id
            alt
          }
        }
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

const PRODUCT_VARIANTS_BULK_UPDATE = `#graphql
  mutation GuidedProductVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants {
        id
        title
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

export type CreateProductResult = {
  ok: boolean;
  partial: boolean;
  productId?: string;
  productAdminUrl?: string;
  message: string;
  failures: string[];
};

export type ProductUploadFiles = {
  images?: Map<string, File>;
  pdf?: File;
};

export type ProductUploadedResources = {
  images?: Map<string, string>;
  pdf?: string;
};

export async function createGuidedProduct(
  admin: ShopifyAdminClient,
  shop: string,
  unsafePayload: unknown,
  uploadFiles: ProductUploadFiles = {},
  uploadedResources: ProductUploadedResources = {},
): Promise<CreateProductResult> {
  const parsed = productCreatorPayloadSchema.safeParse(unsafePayload);
  if (!parsed.success) {
    return {
      ok: false,
      partial: false,
      message: summarizeZodError(parsed.error).join(" "),
      failures: summarizeZodError(parsed.error),
    };
  }

  const payload = parsed.data;
  if (process.env.DEV_MOCK_SHOPIFY === "true") {
    return mockCreateProductResult(shop, payload);
  }

  let productId: string | undefined;
  const failures: string[] = [];

  try {
    await safeLogOperation({
      shop,
      draftId: payload.draftId,
      operation: "create_product:start",
      status: "SUCCESS",
      userMessage: "Creazione prodotto avviata.",
    });

    const imageMedia = await Promise.all(
      payload.images.map(async (image) => {
        const uploadedResourceUrl = image.id
          ? uploadedResources.images?.get(image.id)
          : undefined;
        const upload = image.id ? uploadFiles.images?.get(image.id) : undefined;
        const resourceUrl =
          uploadedResourceUrl ??
          (upload
            ? (await stagedUploadFile(admin, image, upload, "IMAGE")).resourceUrl
            : (await stagedUploadFromDataUrl(admin, image, "IMAGE")).resourceUrl);
        return {
          originalSource: resourceUrl,
          mediaContentType: "IMAGE" as const,
          alt: image.colorName,
        };
      }),
    );

    const createdProduct = await createProduct(admin, payload, imageMedia);
    productId = createdProduct.id;

    await runPostCreateStep(failures, "Creazione varianti", async () => {
      if (payload.category === "Pellicole") {
        const mediaByAlt = new Map(
          createdProduct.media.map((media) => [media.alt?.toLowerCase(), media.id]),
        );
        const variants = generateFilmVariants(payload.images, payload.heights).map(
          (variant) => ({
            optionValues: variant.optionValues,
            ...(variant.sku ? { inventoryItem: { sku: variant.sku } } : {}),
            ...(variant.colorName
              ? { mediaId: mediaByAlt.get(variant.colorName.toLowerCase()) }
              : {}),
          }),
        );

        await createVariants(admin, productId!, variants);
      } else if (payload.accessorySku?.trim() && createdProduct.defaultVariantId) {
        await updateDefaultVariantSku(
          admin,
          productId!,
          createdProduct.defaultVariantId,
          payload.accessorySku.trim(),
        );
      }
    });

    await runPostCreateStep(failures, "Specifiche prodotto", async () => {
      await createProductSpecEntries(admin, productId!, payload.specs, productSpecsSku(payload));
    });

    await runPostCreateStep(failures, "PDF info prodotto", async () => {
      if (!payload.pdf) return;
      const pdfFileId = uploadedResources.pdf
        ? await createShopifyFileFromResourceUrl(
            admin,
            uploadedResources.pdf,
            `Info prodotto ${payload.title}`,
          )
        : uploadFiles.pdf
        ? await createShopifyFileFromUpload(
            admin,
            payload.pdf,
            uploadFiles.pdf,
            `Info prodotto ${payload.title}`,
          )
        : payload.pdf.dataUrl
          ? await createShopifyFile(admin, payload.pdf, `Info prodotto ${payload.title}`)
          : null;
      if (!pdfFileId) return;
      await attachPdfMetafield(admin, productId!, pdfFileId);
    });

    await runPostCreateStep(failures, "Aggiunta collezione", async () => {
      await addProductToCollection(admin, payload.collectionId, productId!);
    });

    const partial = failures.length > 0;

    await safeLogOperation({
      shop,
      draftId: payload.draftId,
      productId,
      operation: "create_product:finish",
      status: partial ? "PARTIAL" : "SUCCESS",
      userMessage: partial
        ? "Prodotto creato parzialmente."
        : "Prodotto creato correttamente.",
      technicalDetail: { failures },
    });

    return {
      ok: true,
      partial,
      productId,
      productAdminUrl: productAdminUrl(shop, productId),
      message: partial
        ? "Prodotto creato, ma alcune operazioni non sono riuscite."
        : "Prodotto creato correttamente in Shopify.",
      failures,
    };
  } catch (error) {
    const normalized = normalizeShopifyError(error);
    await safeLogOperation({
      shop,
      draftId: payload.draftId,
      productId,
      operation: "create_product:error",
      status: productId ? "PARTIAL" : "ERROR",
      userMessage: normalized.userMessage,
      technicalDetail: normalized.technicalDetail,
    });

    return {
      ok: Boolean(productId),
      partial: Boolean(productId),
      productId,
      productAdminUrl: productId ? productAdminUrl(shop, productId) : undefined,
      message: productId
        ? "Prodotto creato parzialmente: un passaggio successivo e fallito."
        : normalized.userMessage,
      failures: [normalized.userMessage],
    };
  }
}

async function safeLogOperation(input: Parameters<typeof logOperation>[0]) {
  try {
    await logOperation(input);
  } catch (error) {
    console.error("OperationLog failed", error);
  }
}

async function createProduct(
  admin: ShopifyAdminClient,
  payload: ProductCreatorPayload,
  media: Array<{ originalSource: string; mediaContentType: "IMAGE"; alt: string }>,
) {
  const productOptions =
    payload.category === "Pellicole"
      ? [
          {
            name: "Colore",
            values: payload.images.map((image) => ({ name: image.colorName })),
          },
          {
            name: "Altezza",
            values: payload.heights.map((height) => ({ name: height.label })),
          },
        ]
      : undefined;

  const data = await shopifyGraphql<{
    productCreate: {
      product: {
        id: string;
        handle: string;
        media: {
          nodes: Array<{ id: string; alt: string | null; mediaContentType: string }>;
        };
        variants: { nodes: Array<{ id: string }> };
      } | null;
      userErrors: Array<{ message: string }>;
    };
  }>(admin, PRODUCT_CREATE, {
    product: {
      title: payload.title,
      vendor: payload.brand || undefined,
      productType: payload.category,
      status: payload.publishNow ? "ACTIVE" : "DRAFT",
      ...(productOptions ? { productOptions } : {}),
    },
    media,
  });

  assertNoUserErrors(data.productCreate.userErrors, "Creazione prodotto");
  if (!data.productCreate.product) {
    throw new Error("Shopify non ha restituito il prodotto creato.");
  }

  return {
    id: data.productCreate.product.id,
    handle: data.productCreate.product.handle,
    media: data.productCreate.product.media.nodes,
    defaultVariantId: data.productCreate.product.variants.nodes[0]?.id,
  };
}

async function createVariants(
  admin: ShopifyAdminClient,
  productId: string,
  variants: Array<Record<string, unknown>>,
) {
  if (!variants.length) return;

  const data = await shopifyGraphql<{
    productVariantsBulkCreate: {
      productVariants: Array<{ id: string }>;
      userErrors: Array<{ message: string }>;
    };
  }>(admin, PRODUCT_VARIANTS_BULK_CREATE, {
    productId,
    variants,
    strategy: "REMOVE_STANDALONE_VARIANT",
  });

  assertNoUserErrors(data.productVariantsBulkCreate.userErrors, "Creazione varianti");
}

async function updateDefaultVariantSku(
  admin: ShopifyAdminClient,
  productId: string,
  variantId: string,
  sku: string,
) {
  const data = await shopifyGraphql<{
    productVariantsBulkUpdate: {
      userErrors: Array<{ message: string }>;
    };
  }>(admin, PRODUCT_VARIANTS_BULK_UPDATE, {
    productId,
    variants: [
      {
        id: variantId,
        inventoryItem: { sku },
      },
    ],
  });

  assertNoUserErrors(data.productVariantsBulkUpdate.userErrors, "Aggiornamento SKU");
}

async function attachPdfMetafield(
  admin: ShopifyAdminClient,
  productId: string,
  fileId: string,
) {
  const definition = await getProductMetafieldDefinition(
    admin,
    "custom",
    "file_info_del_prodotto",
  );

  if (definition && definition.type.name !== "file_reference") {
    throw new Error(
      "Il metafield custom.file_info_del_prodotto esiste ma non e di tipo file_reference.",
    );
  }

  await setProductMetafields(admin, [
    {
      ownerId: productId,
      namespace: "custom",
      key: "file_info_del_prodotto",
      type: "file_reference",
      value: fileId,
    },
  ]);
}

async function runPostCreateStep(
  failures: string[],
  label: string,
  step: () => Promise<void>,
) {
  try {
    await step();
  } catch (error) {
    failures.push(`${label}: ${error instanceof Error ? error.message : "errore sconosciuto"}`);
  }
}

function productAdminUrl(shop: string, productId: string) {
  const numericId = productId.split("/").at(-1);
  return `https://${shop}/admin/products/${numericId}`;
}

function mockCreateProductResult(shop: string, payload: ProductCreatorPayload) {
  const productId = "gid://shopify/Product/1000000000";
  return {
    ok: true,
    partial: payload.collectionType === "SMART",
    productId,
    productAdminUrl: productAdminUrl(shop, productId),
    message:
      payload.collectionType === "SMART"
        ? "Mock: prodotto creato, collezione smart non aggiunta manualmente."
        : "Mock: prodotto creato correttamente.",
    failures:
      payload.collectionType === "SMART"
        ? ["Aggiunta collezione: le collezioni automatiche non accettano aggiunte manuali."]
        : [],
  };
}
