import { describe, expect, it } from "vitest";
import {
  findDuplicateVariantSkus,
  generateFilmVariants,
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
      "Nome colore duplicato: rosso.",
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
