import { describe, expect, it } from "vitest";
import {
  findDuplicateVariantSkus,
  generateFilmVariants,
  groupImagesByVariantColor,
  normalizeImageTitleFromFilename,
  normalizeColorNameFromFilename,
  productCreatorPayloadSchema,
  resolveProductSpecsMapping,
  slugifyHandle,
  specHandle,
} from "./product-creator";

describe("product creator utilities", () => {
  it("normalizes color names from filenames", () => {
    expect(normalizeColorNameFromFilename("Rosso-Mattone.jpg")).toBe("Rosso Mattone");
    expect(normalizeColorNameFromFilename("blu_notte.webp")).toBe("blu notte");
    expect(normalizeColorNameFromFilename(" Verde   Salvia.PNG")).toBe("Verde Salvia");
  });

  it("normalizes image titles and variant color groups", () => {
    expect(normalizeImageTitleFromFilename("Traffic-Yellow_1.jpg")).toBe("Traffic Yellow_1");
    expect(groupImagesByVariantColor([
      {
        fileName: "yellow-1.jpg",
        colorName: "Traffic Yellow_1",
        variantColorName: "Traffic Yellow",
        isColorCover: false,
      },
      {
        fileName: "yellow-2.jpg",
        colorName: "Traffic Yellow_2",
        variantColorName: "Traffic Yellow",
        isColorCover: true,
      },
    ])).toMatchObject([
      {
        name: "Traffic Yellow",
        cover: { colorName: "Traffic Yellow_2" },
      },
    ]);
  });

  it("slugifies handles for Shopify/metaobject usage", () => {
    expect(slugifyHandle("Pellicola Hévéa 120 cm")).toBe("pellicola-hevea-120-cm");
    expect(specHandle("Tipo di adesivo", "ABC 123")).toBe("tipo_di_adesivo_abc_123");
  });

  it("generates Colore x Altezza film variants and height-specific SKUs", () => {
    const variants = generateFilmVariants(
      [
        { fileName: "rosso.jpg", colorName: "Rosso", colorSku: "RS" },
        { fileName: "blu.jpg", colorName: "Blu", colorSku: "BL" },
      ],
      [
        { id: "h1", label: "60 cm" },
        { id: "h2", label: "120 cm" },
      ],
    );

    expect(variants).toHaveLength(4);
    expect(variants.map((variant) => variant.sku)).toEqual([
      "RS-60-cm",
      "RS-120-cm",
      "BL-60-cm",
      "BL-120-cm",
    ]);
  });

  it("keeps base color SKU when a film has one height", () => {
    const [variant] = generateFilmVariants(
      [{ fileName: "rosso.jpg", colorName: "Rosso", colorSku: "RS" }],
      [{ id: "h1", label: "60 cm" }],
    );

    expect(variant.sku).toBe("RS");
  });

  it("groups multiple images into one color variant", () => {
    const variants = generateFilmVariants(
      [
        {
          fileName: "yellow-1.jpg",
          colorName: "Traffic Yellow_1",
          variantColorName: "Traffic Yellow",
          colorSku: "98814",
        },
        {
          fileName: "yellow-2.jpg",
          colorName: "Traffic Yellow_2",
          variantColorName: "Traffic Yellow",
          colorSku: "98814",
          isColorCover: true,
        },
      ],
      [
        { id: "h1", label: "76 Cm" },
        { id: "h2", label: "51 Cm" },
      ],
    );

    expect(variants.map((variant) => variant.sku)).toEqual([
      "98814-76-cm",
      "98814-51-cm",
    ]);
    expect(variants.map((variant) => variant.colorName)).toEqual([
      "Traffic Yellow",
      "Traffic Yellow",
    ]);
    expect(variants.map((variant) => variant.mediaAlt)).toEqual([
      "Traffic Yellow_2",
      "Traffic Yellow_2",
    ]);
    expect(findDuplicateVariantSkus(variants)).toEqual([]);
  });

  it("disambiguates repeated color SKUs across distinct colors when there is only one height", () => {
    const variants = generateFilmVariants(
      [
        { fileName: "yellow.jpg", colorName: "Traffic Yellow", colorSku: "98814" },
        { fileName: "orange.jpg", colorName: "Traffic Orange", colorSku: "98814" },
      ],
      [{ id: "h1", label: "76 Cm" }],
    );

    expect(variants.map((variant) => variant.sku)).toEqual([
      "98814-traffic-yellow",
      "98814-traffic-orange",
    ]);
  });

  it("validates required Pellicole data and duplicates", () => {
    const result = productCreatorPayloadSchema.safeParse({
      collectionId: "gid://shopify/Collection/1",
      title: "Pellicola prova",
      category: "Pellicole",
      images: [
        {
          fileName: "rosso.jpg",
          mimeType: "image/jpeg",
          size: 10,
          colorName: "Rosso",
          colorSku: "A",
        },
        {
          fileName: "rosso-2.jpg",
          mimeType: "image/jpeg",
          size: 10,
          colorName: "rosso",
          colorSku: "A",
        },
      ],
      heights: [{ id: "h1", label: "60 cm" }],
      specs: [],
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.message)).toContain(
      "Titolo immagine duplicato: rosso.",
    );
    expect(findDuplicateVariantSkus([{ sku: "A" }, { sku: "A" }])).toEqual(["A"]);
  });

  it("resolves Product Specs mapping from schema or env overrides", () => {
    expect(
      resolveProductSpecsMapping([{ key: "titolo" }, { key: "valore" }, { key: "sku" }]),
    ).toEqual({
      titleField: "titolo",
      valueField: "valore",
      skuField: "sku",
      type: undefined,
    });

    expect(
      resolveProductSpecsMapping([{ key: "label" }, { key: "body" }], {
        PRODUCT_SPECS_METAOBJECT_TYPE: "product_spec",
        PRODUCT_SPECS_TITLE_FIELD: "label",
        PRODUCT_SPECS_VALUE_FIELD: "body",
      }),
    ).toEqual({
      titleField: "label",
      valueField: "body",
      skuField: undefined,
      type: "product_spec",
    });
  });
});
