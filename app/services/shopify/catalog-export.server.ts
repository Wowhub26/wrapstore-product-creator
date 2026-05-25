import { shopifyGraphql, type ShopifyAdminClient } from "./common.server";

export type ProductCatalogItem = {
  id: string;
  numericId: string;
  title: string;
  handle: string;
};

const PRODUCTS_CATALOG_QUERY = `#graphql
  query ProductsCatalog($cursor: String) {
    products(first: 250, after: $cursor, sortKey: TITLE) {
      nodes {
        id
        title
        handle
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

type ProductsCatalogResponse = {
  products: {
    nodes: Array<{ id: string; title: string; handle: string }>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
};

export async function fetchProductCatalog(
  admin: ShopifyAdminClient,
): Promise<ProductCatalogItem[]> {
  const products: ProductCatalogItem[] = [];
  let cursor: string | null = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const data: ProductsCatalogResponse = await shopifyGraphql<ProductsCatalogResponse>(
      admin,
      PRODUCTS_CATALOG_QUERY,
      { cursor },
    );

    products.push(
      ...data.products.nodes.map((product) => ({
        ...product,
        numericId: productIdFromGid(product.id),
      })),
    );

    hasNextPage = data.products.pageInfo.hasNextPage;
    cursor = data.products.pageInfo.endCursor;
  }

  return products;
}

export function productCatalogToCsv(products: ProductCatalogItem[]) {
  const rows = [
    ["title", "handle", "product_id", "admin_graphql_api_id"],
    ...products.map((product) => [
      product.title,
      product.handle,
      product.numericId,
      product.id,
    ]),
  ];

  return `\uFEFF${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

export function productIdFromGid(gid: string) {
  return gid.split("/").at(-1) ?? gid;
}

function csvCell(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}
