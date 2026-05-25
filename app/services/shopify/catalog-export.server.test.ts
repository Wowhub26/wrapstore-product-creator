import { describe, expect, it } from "vitest";
import { productCatalogToCsv, productIdFromGid } from "./catalog-export.server";

describe("catalog export utilities", () => {
  it("extracts the numeric product id from Shopify gids", () => {
    expect(productIdFromGid("gid://shopify/Product/1234567890")).toBe("1234567890");
  });

  it("exports a UTF-8 CSV with escaped values", () => {
    expect(
      productCatalogToCsv([
        {
          id: "gid://shopify/Product/123",
          numericId: "123",
          title: 'Banner "Premium", 100x200',
          handle: "banner-premium",
        },
      ]),
    ).toBe(
      '\uFEFF"title","handle","product_id","admin_graphql_api_id"\n"Banner ""Premium"", 100x200","banner-premium","123","gid://shopify/Product/123"\n',
    );
  });
});
