import { describe, expect, it } from "vitest";
import {
  findDuplicateVariantSkus,
  generateAccessoryOptionDefinitions,
  generateAccessoryVariantsFromOptions,
  generateFilmVariants,
  groupImagesByVariantColor,
  isValidHexColor,
  normalizeHexColor,
  normalizeImageTitleFromFilename,
  normalizeColorNameFromFilename,
  productCreatorPayloadSchema,
  resolveProductSpecsMapping,
  slugifyHandle,
  specHandle,
  suggestedHexFromColorName,
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
        colorHex: "#D7B400",
        isColorCover: false,
      },
      {
        fileName: "yellow-2.jpg",
        colorName: "Traffic Yellow_2",
        variantColorName: "Traffic Yellow",
        colorHex: "#D4AF37",
        isColorCover: true,
      },
    ])).toMatchObject([
      {
        name: "Traffic Yellow",
        cover: { colorName: "Traffic Yellow_2", colorHex: "#D4AF37" },
      },
    ]);
  });

  it("normalizes and validates HEX colors", () => {
    expect(normalizeHexColor("a36b43")).toBe("#A36B43");
    expect(normalizeHexColor("#abc")).toBe("#AABBCC");
    expect(isValidHexColor("#A36B43")).toBe(true);
    expect(isValidHexColor("rosso")).toBe(false);
  });

  it("suggests fallback HEX colors from names", () => {
    expect(suggestedHexFromColorName("Black Disco")).toBe("#1F1F1F");
    expect(suggestedHexFromColorName("Cinnamon Spice")).toBe("#6A4532");
    expect(suggestedHexFromColorName("Champagne")).toBe("#C7B38A");
  });

  it("slugifies handles for Shopify/metaobject usage", () => {
    expect(slugifyHandle("Pellicola Hévéa 120 cm")).toBe("pellicola-hevea-120-cm");
    expect(specHandle("Tipo di adesivo", "ABC 123")).toBe("tipo_di_adesivo_abc_123");
  });

  it("generates Colore x Altezza film variants and keeps the color SKU", () => {
    const variants = generateFilmVariants(
      [
        { fileName: "rosso.jpg", colorName: "Rosso", colorSku: "RS" },
        { fileName: "blu.jpg", colorName: "Blu", colorSku: "BL", colorHex: "#2244AA" },
      ],
      [
        { id: "h1", label: "60 cm" },
        { id: "h2", label: "120 cm" },
      ],
    );

    expect(variants).toHaveLength(4);
    expect(variants.map((variant) => variant.sku)).toEqual([
      "RS",
      "RS",
      "BL",
      "BL",
    ]);
    expect(variants[2]?.colorHex).toBe("#2244AA");
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
          colorHex: "#D7B400",
          colorSku: "98814",
        },
        {
          fileName: "yellow-2.jpg",
          colorName: "Traffic Yellow_2",
          variantColorName: "Traffic Yellow",
          colorHex: "#D4AF37",
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
      "98814",
      "98814",
    ]);
    expect(variants.map((variant) => variant.colorName)).toEqual([
      "Traffic Yellow",
      "Traffic Yellow",
    ]);
    expect(variants.map((variant) => variant.mediaAlt)).toEqual([
      "Traffic Yellow_2",
      "Traffic Yellow_2",
    ]);
    expect(variants.map((variant) => variant.colorHex)).toEqual([
      "#D4AF37",
      "#D4AF37",
    ]);
    expect(findDuplicateVariantSkus(variants)).toEqual(["98814"]);
  });

  it("allows repeated color SKUs across distinct colors", () => {
    const variants = generateFilmVariants(
      [
        { fileName: "yellow.jpg", colorName: "Traffic Yellow", colorSku: "98814" },
        { fileName: "orange.jpg", colorName: "Traffic Orange", colorSku: "98814" },
      ],
      [{ id: "h1", label: "76 Cm" }],
    );

    expect(variants.map((variant) => variant.sku)).toEqual([
      "98814",
      "98814",
    ]);
  });

  it("generates accessory variants from color and size options", () => {
    const variants = generateAccessoryVariantsFromOptions(
      [
        { name: "Colore", type: "color", values: [] },
        { name: "Taglia", type: "custom", values: ["S", "M"] },
      ],
      [
        { fileName: "black.jpg", colorName: "Black Disco", colorHex: "#292017", colorSku: "BK1", isColorCover: true },
        { fileName: "gold.jpg", colorName: "Gold Disco", colorHex: "#C99A1A", colorSku: "GD1", isColorCover: true },
      ],
      "ACC-BASE",
    );

    expect(variants).toHaveLength(4);
    expect(variants[0]?.optionValues).toEqual([
      { optionName: "Colore", name: "Black Disco" },
      { optionName: "Taglia", name: "S" },
    ]);
    expect(variants.map((variant) => variant.colorHex)).toEqual([
      "#292017",
      "#292017",
      "#C99A1A",
      "#C99A1A",
    ]);
    expect(variants.map((variant) => variant.sku)).toEqual(["BK1", "BK1", "GD1", "GD1"]);
  });

  it("builds accessory option definitions for Shopify product options", () => {
    expect(
      generateAccessoryOptionDefinitions(
        [
          { name: "Colore", type: "color", values: [] },
          { name: "Taglia", type: "custom", values: ["XS", "S", "M"] },
        ],
        [{ fileName: "black.jpg", colorName: "Black Disco", colorHex: "#292017", isColorCover: true }],
      ),
    ).toMatchObject([
      { name: "Colore", values: [{ name: "Black Disco", colorHex: "#292017" }] },
      { name: "Taglia", values: [{ name: "XS" }, { name: "S" }, { name: "M" }] },
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
