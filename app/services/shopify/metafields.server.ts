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
      }
    }
  }
`;

const METAFIELD_DEFINITION_CREATE = `#graphql
  mutation GuidedProductMetafieldDefinitionCreate($definition: MetafieldDefinitionInput!) {
    metafieldDefinitionCreate(definition: $definition) {
      createdDefinition {
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
      userErrors {
        field
        message
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

export async function ensureProductMetaobjectListDefinition(
  admin: ShopifyAdminClient,
  {
    namespace,
    key,
    name,
    metaobjectDefinitionId,
    description,
  }: {
    namespace: string;
    key: string;
    name: string;
    metaobjectDefinitionId: string;
    description?: string;
  },
) {
  const existing = await getProductMetafieldDefinition(admin, namespace, key);
  if (existing) return existing;

  const data = await shopifyGraphql<{
    metafieldDefinitionCreate: {
      createdDefinition: {
        id: string;
        name: string;
        namespace: string;
        key: string;
        type: { name: string };
        validations: Array<{ name: string; value: string }>;
      } | null;
      userErrors: Array<{ message: string }>;
    };
  }>(admin, METAFIELD_DEFINITION_CREATE, {
    definition: {
      name,
      namespace,
      key,
      description,
      type: "list.metaobject_reference",
      ownerType: "PRODUCT",
      access: {
        storefront: "PUBLIC_READ",
      },
      validation: {
        metaobjectDefinitionId,
      },
    },
  });

  assertNoUserErrors(
    data.metafieldDefinitionCreate.userErrors,
    `Creazione definizione metafield ${namespace}.${key}`,
  );

  const created = data.metafieldDefinitionCreate.createdDefinition;
  if (!created) {
    throw new Error(
      `Shopify non ha creato la definizione metafield ${namespace}.${key}.`,
    );
  }

  return created;
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
