import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import type { ProductCreatorPayload } from "../lib/product-creator";
import { createStagedUploadTargets } from "../services/shopify/files.server";
import { createGuidedProduct, type CreateProductResult } from "../services/shopify/products.server";
import { logOperation } from "../services/operation-log.server";

type ActionResponse = {
  ok: boolean;
  errors?: string[];
  draftId?: string;
  result?: CreateProductResult;
  uploadTargets?: Array<{
    key: string;
    url: string;
    resourceUrl: string;
    parameters: Array<{ name: string; value: string }>;
  }>;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return Response.json({ ok: false, errors: ["Endpoint solo POST."] }, { status: 405 });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  try {
    const body = await request.json();
    const intent = String(body.intent ?? "");
    const payload = body.payload as ProductCreatorPayload | undefined;

    if (intent === "prepareUploads") {
      const files = (body.files ?? []) as Array<{
        key: string;
        fileName: string;
        mimeType: string;
        resource: "IMAGE" | "FILE";
      }>;
      const targets = await createStagedUploadTargets(admin, files);
      return actionJson({
        ok: true,
        uploadTargets: targets.map((target, index) => ({
          key: files[index].key,
          ...target,
        })),
      });
    }

    if (!payload) {
      return actionJson({ ok: false, errors: ["Payload mancante."] });
    }

    if (intent === "saveDraft") {
      const draftId = await saveDraft(session.shop, payload, body.draftId);
      return actionJson({ ok: true, draftId });
    }

    if (intent === "createProduct") {
      const limitErrors = validateUploadLimits(payload);
      if (limitErrors.length) {
        return actionJson({ ok: false, errors: limitErrors });
      }

      const uploadedResources = body.uploadedResources as
        | {
            images?: Array<{ id: string; resourceUrl: string }>;
            pdf?: { resourceUrl: string };
          }
        | undefined;
      const imageResources = new Map(
        uploadedResources?.images?.map((image) => [image.id, image.resourceUrl]) ?? [],
      );

      const result = await createGuidedProduct(
        admin,
        session.shop,
        payload,
        {},
        {
          images: imageResources,
          pdf: uploadedResources?.pdf?.resourceUrl,
        },
      );

      if (payload.draftId || body.draftId) {
        await saveDraft(session.shop, { ...payload, draftId: payload.draftId || body.draftId }, body.draftId);
      }

      return actionJson({ ok: result.ok, result, errors: result.ok ? undefined : result.failures });
    }

    return actionJson({ ok: false, errors: ["Azione non riconosciuta."] });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Errore imprevisto durante l'operazione.";
    await safeLogActionError(session.shop, message, error);
    console.error("Product creator API action failed", error);
    return actionJson({ ok: false, errors: [message] });
  }
};

function actionJson(body: ActionResponse, init?: ResponseInit) {
  return Response.json(body, init);
}

function validateUploadLimits(payload: ProductCreatorPayload) {
  const errors: string[] = [];
  const maxImages = Number(process.env.MAX_PRODUCT_IMAGES ?? 24);
  const maxPdfMb = Number(process.env.MAX_PRODUCT_PDF_MB ?? 20);
  if (payload.images.length > maxImages) errors.push(`Massimo ${maxImages} immagini.`);
  if (payload.pdf && payload.pdf.size > maxPdfMb * 1024 * 1024) {
    errors.push(`Il PDF supera il limite di ${maxPdfMb} MB.`);
  }
  return errors;
}

async function saveDraft(shop: string, payload: ProductCreatorPayload, draftId?: string) {
  const existing = draftId
    ? await prisma.productDraft.findFirst({ where: { id: draftId, shop } })
    : null;
  const data = {
    shop,
    title: payload.title || null,
    category: payload.category,
    brand: payload.brand || null,
    collectionId: payload.collectionId || null,
    collectionTitle: payload.collectionTitle || null,
    collectionType: payload.collectionType || null,
    publishNow: false,
    selectedHeights: payload.heights,
    specs: payload.specs,
    accessorySku: payload.accessorySku || null,
    pdfFileName: payload.pdf?.fileName ?? null,
    pdfMimeType: payload.pdf?.mimeType ?? null,
    pdfSize: payload.pdf?.size ?? null,
    pdfDataUrl: payload.pdf?.dataUrl ?? null,
    payload: { ...payload, publishNow: false },
  };

  const draft = existing
    ? await prisma.productDraft.update({
        where: { id: existing.id },
        data: {
          ...data,
          images: {
            deleteMany: {},
            create: payload.images.map((image, index) => ({
              fileName: image.fileName,
              mimeType: image.mimeType,
              size: image.size,
              colorName: image.colorName,
              colorSku: image.colorSku || null,
              previewDataUrl: image.dataUrl ?? null,
              position: index,
            })),
          },
        },
      })
    : await prisma.productDraft.create({
        data: {
          ...data,
          images: {
            create: payload.images.map((image, index) => ({
              fileName: image.fileName,
              mimeType: image.mimeType,
              size: image.size,
              colorName: image.colorName,
              colorSku: image.colorSku || null,
              previewDataUrl: image.dataUrl ?? null,
              position: index,
            })),
          },
        },
      });

  return draft.id;
}

async function safeLogActionError(shop: string, message: string, error: unknown) {
  try {
    await logOperation({
      shop,
      operation: "product_creator:api_action_error",
      status: "ERROR",
      userMessage: message,
      technicalDetail: serializeError(error),
    });
  } catch (logError) {
    console.error("OperationLog failed", logError);
  }
}

function serializeError(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  return { message: String(error) };
}
