import { z } from "zod";

export const PRODUCT_CATEGORIES = ["Pellicole", "Accessori"] as const;
export const ACCEPTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export const ACCEPTED_PDF_TYPES = ["application/pdf"] as const;

export type ProductCategory = (typeof PRODUCT_CATEGORIES)[number];

export type ColorImageInput = {
  id?: string;
  fileName: string;
  mimeType: string;
  size: number;
  dataUrl?: string;
  colorName: string;
  colorSku?: string;
  position?: number;
};

export type HeightInput = {
  id: string;
  label: string;
  value?: string;
  handle?: string;
};

export type ProductSpecInput = {
  key: string;
  title: string;
  value?: string;
};

export type ProductCreatorPayload = {
  draftId?: string;
  collectionId: string;
  collectionTitle?: string;
  collectionType?: "MANUAL" | "SMART" | string;
  title: string;
  category: ProductCategory;
  brand?: string;
  publishNow?: boolean;
  images: ColorImageInput[];
  heights: HeightInput[];
  pdf?: {
    fileName: string;
    mimeType: string;
    size: number;
    dataUrl?: string;
  } | null;
  specs: ProductSpecInput[];
  accessorySku?: string;
};

export type GeneratedVariant = {
  colorName?: string;
  heightLabel?: string;
  sku?: string;
  optionValues: { optionName: string; name: string }[];
  mediaFileName?: string;
};

export type ProductSpecsMapping = {
  type?: string;
  titleField: string;
  valueField: string;
  skuField?: string;
};

const nonEmptyString = z.string().trim().min(1);

export const colorImageSchema = z.object({
  id: z.string().optional(),
  fileName: nonEmptyString,
  mimeType: z.enum(ACCEPTED_IMAGE_TYPES),
  size: z.number().int().positive(),
  dataUrl: z.string().optional(),
  colorName: nonEmptyString,
  colorSku: z.string().trim().optional(),
  position: z.number().int().nonnegative().optional(),
});

export const heightSchema = z.object({
  id: nonEmptyString,
  label: nonEmptyString,
  value: z.string().optional(),
  handle: z.string().optional(),
});

export const productSpecSchema = z.object({
  key: nonEmptyString,
  title: nonEmptyString,
  value: z.string().trim().optional(),
});

export const productCreatorPayloadSchema = z
  .object({
    draftId: z.string().optional(),
    collectionId: nonEmptyString,
    collectionTitle: z.string().optional(),
    collectionType: z.string().optional(),
    title: nonEmptyString,
    category: z.enum(PRODUCT_CATEGORIES),
    brand: z.string().trim().optional(),
    publishNow: z.boolean().optional(),
    images: z.array(colorImageSchema),
    heights: z.array(heightSchema),
    pdf: z
      .object({
        fileName: nonEmptyString,
        mimeType: z.enum(ACCEPTED_PDF_TYPES),
        size: z.number().int().positive(),
        dataUrl: z.string().optional(),
      })
      .nullable()
      .optional(),
    specs: z.array(productSpecSchema),
    accessorySku: z.string().trim().optional(),
  })
  .superRefine((payload, context) => {
    const duplicateColors = findDuplicateValues(
      payload.images.map((image) => image.colorName),
    );
    duplicateColors.forEach((color) => {
      context.addIssue({
        code: "custom",
        path: ["images"],
        message: `Nome colore duplicato: ${color}.`,
      });
    });

    if (payload.category === "Pellicole") {
      if (!payload.images.length) {
        context.addIssue({
          code: "custom",
          path: ["images"],
          message: "Carica almeno una immagine/colore per le Pellicole.",
        });
      }
      if (!payload.heights.length) {
        context.addIssue({
          code: "custom",
          path: ["heights"],
          message: "Seleziona almeno una altezza per le Pellicole.",
        });
      }

      const duplicateSkus = findDuplicateVariantSkus(
        generateFilmVariants(payload.images, payload.heights),
      );
      duplicateSkus.forEach((sku) => {
        context.addIssue({
          code: "custom",
          path: ["images"],
          message: `SKU variante duplicato: ${sku}. Usa SKU colore diversi oppure lascia vuoto lo SKU colore.`,
        });
      });
    }
  });

export function normalizeColorNameFromFilename(fileName: string) {
  const nameOnly = fileName.replace(/\.[^.\\/]+$/, "");
  return nameOnly.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
}

export function slugifyHandle(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

export function generateFilmVariants(
  images: Pick<ColorImageInput, "colorName" | "colorSku" | "fileName">[],
  heights: Pick<HeightInput, "id" | "label" | "value" | "handle">[],
): GeneratedVariant[] {
  return images.flatMap((image) =>
    heights.map((height) => {
      const baseSku = image.colorSku?.trim();
      const heightSlug = slugifyHandle(height.value || height.handle || height.label);
      const sku =
        !baseSku ? "" : heights.length === 1 ? baseSku : `${baseSku}-${heightSlug}`;

      return {
        colorName: image.colorName,
        heightLabel: height.label,
        sku,
        mediaFileName: image.fileName,
        optionValues: [
          { optionName: "Colore", name: image.colorName },
          { optionName: "Altezza", name: height.label },
        ],
      };
    }),
  );
}

export function generateAccessoryVariants(accessorySku?: string): GeneratedVariant[] {
  return [
    {
      sku: accessorySku?.trim() || "",
      optionValues: [],
    },
  ];
}

export function findDuplicateValues(values: string[]) {
  const seen = new Set<string>();
  const duplicates = new Set<string>();

  values
    .map((value) => value.trim())
    .filter(Boolean)
    .forEach((value) => {
      const key = value.toLocaleLowerCase("it-IT");
      if (seen.has(key)) duplicates.add(value);
      seen.add(key);
    });

  return [...duplicates];
}

export function findDuplicateVariantSkus(variants: Pick<GeneratedVariant, "sku">[]) {
  return findDuplicateValues(
    variants.map((variant) => variant.sku ?? "").filter(Boolean),
  );
}

export function productSpecsSku(payload: Pick<ProductCreatorPayload, "images" | "title">) {
  return (
    payload.images.find((image) => image.colorSku?.trim())?.colorSku?.trim() ||
    slugifyHandle(payload.title)
  );
}

export function specHandle(specTitle: string, sku: string) {
  return `${slugifyHandle(specTitle).replace(/-/g, "_")}_${slugifyHandle(sku).replace(
    /-/g,
    "_",
  )}`;
}

export function resolveProductSpecsMapping(
  definitionFields: { key: string }[],
  env: Record<string, string | undefined> = {},
): ProductSpecsMapping {
  const keys = new Set(definitionFields.map((field) => field.key));
  const firstExisting = (candidates: string[], fallback: string) =>
    candidates.find((candidate) => keys.has(candidate)) ?? fallback;

  return {
    type: env.PRODUCT_SPECS_METAOBJECT_TYPE,
    titleField:
      env.PRODUCT_SPECS_TITLE_FIELD ||
      firstExisting(["title", "titolo", "name", "nome"], "title"),
    valueField:
      env.PRODUCT_SPECS_VALUE_FIELD ||
      firstExisting(["value", "valore", "description", "descrizione"], "value"),
    skuField:
      env.PRODUCT_SPECS_SKU_FIELD ||
      (keys.has("sku") ? "sku" : keys.has("codice") ? "codice" : undefined),
  };
}

export function dataUrlToUpload(dataUrl: string, fileName: string, mimeType: string) {
  const [, base64 = ""] = dataUrl.split(",");
  const binary = Buffer.from(base64, "base64");
  return new File([binary], fileName, { type: mimeType });
}

export function summarizeZodError(error: z.ZodError) {
  return error.issues.map((issue) => issue.message);
}
