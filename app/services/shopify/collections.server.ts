import { assertNoUserErrors, shopifyGraphql, type ShopifyAdminClient } from "./common.server";

export type ShopifyCollection = {
  id: string;
  title: string;
  handle: string;
  type: "MANUAL" | "SMART";
};

const COLLECTIONS_QUERY = `#graphql
  query GuidedProductCollections($cursor: String) {
    collections(first: 100, after: $cursor, sortKey: TITLE) {
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          id
          title
          handle
          ruleSet {
            appliedDisjunctively
          }
        }
      }
    }
  }
`;

const COLLECTION_ADD_PRODUCTS = `#graphql
  mutation GuidedProductCollectionAddProducts($collectionId: ID!, $productIds: [ID!]!) {
    collectionAddProducts(id: $collectionId, productIds: $productIds) {
      collection {
        id
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

export async function getCollections(admin: ShopifyAdminClient) {
  const collections: ShopifyCollection[] = [];
  let cursor: string | null = null;

  do {
    const data: {
      collections: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        edges: Array<{
          node: {
            id: string;
            title: string;
            handle: string;
            ruleSet: unknown | null;
          };
        }>;
      };
    } = await shopifyGraphql(admin, COLLECTIONS_QUERY, { cursor });

    collections.push(
      ...data.collections.edges.map(({ node }) => ({
        id: node.id,
        title: node.title,
        handle: node.handle,
        type: node.ruleSet ? ("SMART" as const) : ("MANUAL" as const),
      })),
    );

    cursor = data.collections.pageInfo.hasNextPage
      ? data.collections.pageInfo.endCursor
      : null;
  } while (cursor);

  return collections;
}

export async function addProductToCollection(
  admin: ShopifyAdminClient,
  collectionId: string,
  productId: string,
) {
  const data = await shopifyGraphql<{
    collectionAddProducts: { userErrors: Array<{ message: string }> };
  }>(admin, COLLECTION_ADD_PRODUCTS, {
    collectionId,
    productIds: [productId],
  });

  assertNoUserErrors(
    data.collectionAddProducts.userErrors,
    "Aggiunta prodotto alla collezione",
  );
}
