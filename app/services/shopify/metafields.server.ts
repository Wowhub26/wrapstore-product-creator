import { assertNoUserErrors, shopifyGraphql, type ShopifyAdminClient } from "./common.server";

const METAFIELD_DEFINITION_QUERY = `#graphql
  query GuidedProductMetafieldDefinition($namespace: String!, $key: String!, $ownerType: MetafieldOwnerType!) {
    metafieldDefinitions(first: 10, namespace: $namespace, key: $key, ownerType: $ownerType) {
      nodes {
        id
        name
        namespace
        key
        type {
          name
        }
        validations {
          name
          value
        }
      }
    }
  }
`;

const METAFIELDS_SET = `#graphql
  mutation GuidedProductMetafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields {
        id
        namespace
        key
        type
        value
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

export async function getProductMetafieldDefinition(
  admin: ShopifyAdminClient,
  namespace: string,
  key: string,
) {
  const data = await shopifyGraphql<{
    metafieldDefinitions: {
      nodes: Array<{
        id: string;
        name: string;
        namespace: string;
        key: string;
        type: { name: string };
        validations: Array<{ name: string; value: string }>;
      }>;
    };
  }>(admin, METAFIELD_DEFINITION_QUERY, {
    namespace,
    key,
    ownerType: "PRODUCT",
  });

  return data.metafieldDefinitions.nodes[0] ?? null;
}

export async function setProductMetafields(
  admin: ShopifyAdminClient,
  metafields: Array<{
    ownerId: string;
    namespace: string;
    key: string;
    type: string;
    value: string;
  }>,
) {
  if (!metafields.length) return [];

  const data = await shopifyGraphql<{
    metafieldsSet: {
      metafields: Array<{ id: string; namespace: string; key: string; value: string }>;
      userErrors: Array<{ message: string }>;
    };
  }>(admin, METAFIELDS_SET, { metafields });

  assertNoUserErrors(data.metafieldsSet.userErrors, "Aggiornamento metafield");
  return data.metafieldsSet.metafields;
}
