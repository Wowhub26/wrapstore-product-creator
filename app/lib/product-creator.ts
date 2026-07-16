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
  variantColorName?: string;
  colorHex?: string;
  colorSku?: string;
  isColorCover?: boolean;
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

export type AccessoryOptionType = "color" | "custom";

export type AccessoryOptionInput = {
  id: string;
  name: string;
  type: AccessoryOptionType;
  values: string[];
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
  accessoryOptions: AccessoryOptionInput[];
};

export type GeneratedVariant = {
  colorName?: string;
  colorHex?: string;
  heightLabel?: string;
  sku?: string;
  optionValues: { optionName: string; name: string }[];
  mediaFileName?: string;
  mediaAlt?: string;
};

export type ProductSpecsMapping = {
  type?: string;
  titleField: string;
  valueField: string;
  skuField?: string;
};

export type AccessoryOptionValueDefinition = {
  name: string;
  colorHex?: string;
  mediaFileName?: string;
  mediaAlt?: string;
  sku?: string;
};

export type AccessoryOptionDefinition = {
  name: string;
  type: AccessoryOptionType;
  values: AccessoryOptionValueDefinition[];
};

const nonEmptyString = z.string().trim().min(1);
const hexColorSchema = z
  .string()
  .trim()
  .transform((value) => normalizeHexColor(value))
  .refine((value) => !value || isValidHexColor(value), {
    message: "Il colore HEX deve essere nel formato #RRGGBB.",
  });

export const colorImageSchema = z.object({
  id: z.string().optional(),
  fileName: nonEmptyString,
  mimeType: z.enum(ACCEPTED_IMAGE_TYPES),
  size: z.number().int().positive(),
  dataUrl: z.string().optional(),
  colorName: nonEmptyString,
  variantColorName: z.string().trim().optional(),
  colorHex: hexColorSchema.optional(),
  colorSku: z.string().trim().optional(),
  isColorCover: z.boolean().optional(),
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

export const accessoryOptionSchema = z.object({
  id: nonEmptyString,
  name: nonEmptyString,
  type: z.enum(["color", "custom"]),
  values: z.array(nonEmptyString),
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
    accessoryOptions: z.array(accessoryOptionSchema).default([]),
  })
  .superRefine((payload, context) => {
    const duplicateImageTitles = findDuplicateValues(
      payload.images.map((image) => image.colorName),
    );
    duplicateImageTitles.forEach((color) => {
      context.addIssue({
        code: "custom",
        path: ["images"],
        message: `Titolo immagine duplicato: ${color}.`,
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

    }

    if (payload.category === "Accessori") {
      const duplicateOptionNames = findDuplicateValues(
        payload.accessoryOptions.map((option) => option.name),
      );
      duplicateOptionNames.forEach((name) => {
        context.addIssue({
          code: "custom",
          path: ["accessoryOptions"],
          message: `Nome variante duplicato: ${name}.`,
        });
      });

      payload.accessoryOptions.forEach((option, optionIndex) => {
        const cleanedValues = option.values.map((value) => value.trim()).filter(Boolean);
        if (!cleanedValues.length) {
          context.addIssue({
            code: "custom",
            path: ["accessoryOptions", optionIndex, "values"],
            message: `La variante "${option.name}" deve avere almeno un valore.`,
          });
        }

        const duplicateValues = findDuplicateValues(cleanedValues);
        duplicateValues.forEach((value) => {
          context.addIssue({
            code: "custom",
            path: ["accessoryOptions", optionIndex, "values"],
            message: `Valore duplicato nella variante "${option.name}": ${value}.`,
          });
        });

        if (option.type === "color" && !payload.images.length) {
          context.addIssue({
            code: "custom",
            path: ["images"],
            message: 'Aggiungi almeno una immagine se vuoi usare la variante "Colore".',
          });
        }
      });
    }
  });

export function normalizeColorNameFromFilename(fileName: string) {
  const nameOnly = fileName.replace(/\.[^.\\/]+$/, "");
  return nameOnly.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
}

export function normalizeImageTitleFromFilename(fileName: string) {
  return normalizeColorNameFromFilename(fileName).replace(/\s+(\d+)$/, "_$1");
}

export function variantColorNameFromImageTitle(imageTitle: string) {
  return imageTitle.replace(/[_\s-]+\d+$/, "").replace(/\s+/g, " ").trim();
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

export function normalizeHexColor(value?: string | null) {
  const normalized = String(value ?? "")
    .trim()
    .replace(/^#?/, "#")
    .toUpperCase();

  if (/^#[0-9A-F]{3}$/.test(normalized)) {
    return `#${normalized
      .slice(1)
      .split("")
      .map((char) => `${char}${char}`)
      .join("")}`;
  }

  return normalized;
}

export function isValidHexColor(value?: string | null) {
  return /^#[0-9A-F]{6}$/.test(normalizeHexColor(value));
}

export function suggestedHexFromColorName(value?: string | null) {
  const normalized = value
    ?.normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

  if (!normalized) return undefined;

  const namedColors: Array<[string[], string]> = [
    [["black", "nero", "midnight"], "#1F1F1F"],
    [["white", "bianco", "sparkling white"], "#F5F5F0"],
    [["red", "rosso", "ruby", "burgundy"], "#A61E24"],
    [["blue", "blu", "navy", "ocean"], "#1E3A6D"],
    [["green", "verde", "olive", "salvia"], "#4E6B47"],
    [["yellow", "giallo", "gold", "oro"], "#C99A1A"],
    [["orange", "arancio", "orange", "copper"], "#C96A2B"],
    [["pink", "rosa"], "#C85A9E"],
    [["purple", "viola"], "#6D4A8E"],
    [["brown", "marrone", "mocha", "cinnamon", "bronze"], "#6A4532"],
    [["grey", "gray", "grigio", "silver", "argento"], "#8D939A"],
    [["beige", "champagne", "sand", "sabbia", "ivory", "avorio"], "#C7B38A"],
  ];

  const exact = namedColors.find(([aliases]) =>
    aliases.some((alias) => normalized.includes(alias)),
  );
  return exact?.[1];
}

export function generateFilmVariants(
  images: Pick<
    ColorImageInput,
    "colorName" | "variantColorName" | "colorHex" | "colorSku" | "fileName" | "isColorCover"
  >[],
  heights: Pick<HeightInput, "id" | "label" | "value" | "handle">[],
): GeneratedVariant[] {
  const colorGroups = groupImagesByVariantColor(images);

  return colorGroups.flatMap((group) =>
    heights.map((height) => {
      const baseSku = group.cover.colorSku?.trim();
      const sku = buildVariantSku(baseSku);

      return {
        colorName: group.name,
        colorHex: group.cover.colorHex,
        heightLabel: height.label,
        sku,
        mediaFileName: group.cover.fileName,
        mediaAlt: group.cover.colorName,
        optionValues: [
          { optionName: "Colore", name: group.name },
          { optionName: "Altezza", name: height.label },
        ],
      };
    }),
  );
}

export function groupImagesByVariantColor(
  images: Pick<
    ColorImageInput,
    "colorName" | "variantColorName" | "colorHex" | "colorSku" | "fileName" | "isColorCover"
  >[],
) {
  const groups = new Map<
    string,
    {
      name: string;
      images: typeof images;
    }
  >();

  images.forEach((image) => {
    const name = (image.variantColorName?.trim() || variantColorNameFromImageTitle(image.colorName)).trim();
    if (!name) return;
    const key = name.toLowerCase();
    const group = groups.get(key) ?? { name, images: [] };
    group.images = [...group.images, image];
    groups.set(key, group);
  });

  return [...groups.values()].map((group) => ({
    ...group,
    cover: group.images.find((image) => image.isColorCover) ?? group.images[0],
  }));
}

function buildVariantSku(baseSku?: string) {
  return baseSku?.trim() || "";
}

export function generateAccessoryVariants(accessorySku?: string): GeneratedVariant[] {
  return [
    {
      sku: accessorySku?.trim() || "",
      optionValues: [],
    },
  ];
}

export function accessoryOptionValues(
  option: Pick<AccessoryOptionInput, "name" | "type" | "values">,
  images: Pick<ColorImageInput, "colorName" | "variantColorName" | "colorHex" | "colorSku" | "fileName" | "isColorCover">[],
): AccessoryOptionValueDefinition[] {
  if (option.type === "color") {
    return groupImagesByVariantColor(images).map((group) => ({
      name: group.name,
      colorHex: group.cover.colorHex,
      mediaFileName: group.cover.fileName,
      mediaAlt: group.cover.colorName,
      sku: group.cover.colorSku?.trim() || "",
    }));
  }

  return option.values.map((value) => ({
    name: value.trim(),
  }));
}

export function generateAccessoryOptionDefinitions(
  options: Pick<AccessoryOptionInput, "name" | "type" | "values">[],
  images: Pick<ColorImageInput, "colorName" | "variantColorName" | "colorHex" | "colorSku" | "fileName" | "isColorCover">[],
): AccessoryOptionDefinition[] {
  return options
    .map((option) => ({
      name: option.name.trim(),
      type: option.type,
      values: accessoryOptionValues(option, images),
    }))
    .filter((option) => option.name && option.values.length);
}

export function generateAccessoryVariantsFromOptions(
  options: Pick<AccessoryOptionInput, "name" | "type" | "values">[],
  images: Pick<ColorImageInput, "colorName" | "variantColorName" | "colorHex" | "colorSku" | "fileName" | "isColorCover">[],
  accessorySku?: string,
): GeneratedVariant[] {
  const definitions = generateAccessoryOptionDefinitions(options, images);
  if (!definitions.length) return generateAccessoryVariants(accessorySku);

  return definitions.reduce<GeneratedVariant[]>(
    (variants, option) =>
      variants.flatMap((variant) =>
        option.values.map((value) => ({
          colorName: value.mediaAlt ? value.name : variant.colorName,
          colorHex: value.colorHex || variant.colorHex,
          sku: variant.sku || value.sku || accessorySku?.trim() || "",
          mediaFileName: value.mediaFileName || variant.mediaFileName,
          mediaAlt: value.mediaAlt || variant.mediaAlt,
          optionValues: [...variant.optionValues, { optionName: option.name, name: value.name }],
        })),
      ),
    [{ sku: "", optionValues: [] }],
  );
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
