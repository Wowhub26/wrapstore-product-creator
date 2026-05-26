import {
  slugifyHandle,
  type ProductSpecInput,
} from "../../lib/product-creator";
import { assertNoUserErrors, shopifyGraphql, type ShopifyAdminClient } from "./common.server";
import { getProductMetafieldDefinition, setProductMetafields } from "./metafields.server";

const METAOBJECTS_BY_TYPE = `#graphql
  query GuidedProductMetaobjectsByType($type: String!, $cursor: String) {
    metaobjects(type: $type, first: 100, after: $cursor) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        handle
        displayName
        fields {
          key
          value
          type
        }
      }
    }
  }
`;

const METAOBJECT_DEFINITION_BY_TYPE = `#graphql
  query GuidedProductMetaobjectDefinitionByType($type: String!) {
    metaobjectDefinitionByType(type: $type) {
      id
      type
      fieldDefinitions {
        key
        name
        type {
          name
        }
      }
    }
  }
`;

const METAOBJECT_DEFINITION_BY_ID = `#graphql
  query GuidedProductMetaobjectDefinitionById($id: ID!) {
    metaobjectDefinition(id: $id) {
      id
      type
    }
  }
`;

const METAOBJECT_DEFINITIONS = `#graphql
  query GuidedProductMetaobjectDefinitions($cursor: String) {
    metaobjectDefinitions(first: 100, after: $cursor) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        name
        type
      }
    }
  }
`;

const METAOBJECT_CREATE = `#graphql
  mutation GuidedProductMetaobjectCreate($metaobject: MetaobjectCreateInput!) {
    metaobjectCreate(metaobject: $metaobject) {
      metaobject {
        id
        handle
        displayName
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export type HeightOption = {
  id: string;
  label: string;
  value: string;
  handle?: string;
};

export async function getHeightOptions(admin: ShopifyAdminClient): Promise<HeightOption[]> {
  const definition = await getProductMetafieldDefinition(admin, "custom", "altezza");

  if (!definition) {
    throw new Error(
      "Metafield custom.altezza non trovato. Verifica la definizione nel pannello Shopify.",
    );
  }

  const metaobjectType = await resolveMetaobjectTypeForDefinition(
    admin,
    definition,
    process.env.ALTEZZA_METAOBJECT_TYPE,
    ["altezza", "height"],
  );

  if (!definition.type.name.includes("metaobject_reference") || !metaobjectType) {
    throw new Error(
      "custom.altezza deve essere un riferimento/lista a metaobject. Imposta ALTEZZA_METAOBJECT_TYPE se Shopify non espone il tipo automaticamente.",
    );
  }

  return getMetaobjectsByType(admin, metaobjectType);
}

export async function getMetaobjectsByType(admin: ShopifyAdminClient, type: string) {
  const options: HeightOption[] = [];
  let cursor: string | null = null;

  do {
    const data: {
      metaobjects: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: Array<{
          id: string;
          handle: string;
          displayName: string;
          fields: Array<{ key: string; value: string; type: string }>;
        }>;
      };
    } = await shopifyGraphql(admin, METAOBJECTS_BY_TYPE, { type, cursor });

    options.push(
      ...data.metaobjects.nodes.map((node) => ({
        id: node.id,
        label:
          node.displayName ||
          node.fields.find((field) => ["title", "titolo", "name", "nome"].includes(field.key))
            ?.value ||
          node.handle,
        value: node.handle || node.displayName,
        handle: node.handle,
      })),
    );

    cursor = data.metaobjects.pageInfo.hasNextPage
      ? data.metaobjects.pageInfo.endCursor
      : null;
  } while (cursor);

  return options;
}

async function resolveMetaobjectTypeForDefinition(
  admin: ShopifyAdminClient,
  definition: {
    validations: Array<{ name: string; value: string }>;
  },
  envType: string | undefined,
  fallbackHints: string[] = [],
) {
  if (envType) return envType;

  const typeValidation = definition.validations.find((validation) =>
    ["metaobject_definition_type", "metaobject_type"].includes(validation.name),
  );
  if (typeValidation?.value) return typeValidation.value;

  const idValidation = definition.validations.find((validation) =>
    ["metaobject_definition_id", "metaobject_definition"].includes(validation.name),
  );
  if (idValidation?.value?.startsWith("gid://shopify/MetaobjectDefinition/")) {
    const data = await shopifyGraphql<{
      metaobjectDefinition: { type: string } | null;
    }>(admin, METAOBJECT_DEFINITION_BY_ID, { id: idValidation.value });

    if (data.metaobjectDefinition?.type) return data.metaobjectDefinition.type;
  }

  return inferMetaobjectTypeFromDefinitions(admin, fallbackHints);
}

async function inferMetaobjectTypeFromDefinitions(
  admin: ShopifyAdminClient,
  hints: string[],
): Promise<string | undefined> {
  const normalizedHints = hints.map((hint) => hint.toLowerCase());
  let cursor: string | null = null;
  const matches: Array<{ type: string }> = [];

  do {
    type MetaobjectDefinitionsResponse = {
      metaobjectDefinitions: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: Array<{ name: string; type: string }>;
      };
    };

    const data: MetaobjectDefinitionsResponse = await shopifyGraphql(
      admin,
      METAOBJECT_DEFINITIONS,
      { cursor },
    );

    matches.push(
      ...data.metaobjectDefinitions.nodes.filter(
        (definition: { name: string; type: string }) => {
          const haystack = `${definition.name} ${definition.type}`.toLowerCase();
          return normalizedHints.some((hint) => haystack.includes(hint));
        },
      ),
    );

    cursor = data.metaobjectDefinitions.pageInfo.hasNextPage
      ? data.metaobjectDefinitions.pageInfo.endCursor
      : null;
  } while (cursor);

  return matches.length === 1 ? matches[0].type : undefined;
}

export async function createProductSpecEntries(
  admin: ShopifyAdminClient,
  productId: string,
  specs: ProductSpecInput[],
  sku: string,
) {
  const filledSpecs = specs.filter((spec) => spec.value?.trim());
  if (!filledSpecs.length) return [];

  const metafieldDefinition = await getProductMetafieldDefinition(
    admin,
    "custom",
    "product_specs",
  );
  const typeFromDefinition =
    process.env.PRODUCT_SPECS_METAOBJECT_TYPE ||
    metafieldDefinition?.validations.find((validation) =>
      ["metaobject_definition_type", "metaobject_type"].includes(validation.name),
    )?.value ||
    "specifiche_prodotto";

  if (!metafieldDefinition?.type.name.includes("metaobject_reference")) {
    throw new Error(
      "custom.product_specs deve essere una lista di riferimenti metaobject compatibile.",
    );
  }

  const definition = await shopifyGraphql<{
    metaobjectDefinitionByType: {
      type: string;
      fieldDefinitions: Array<{ key: string }>;
    } | null;
  }>(admin, METAOBJECT_DEFINITION_BY_TYPE, { type: typeFromDefinition });

  if (!definition.metaobjectDefinitionByType) {
    throw new Error(`Metaobject definition "${typeFromDefinition}" non trovata.`);
  }

  const fields = buildProductSpecsFields(
    definition.metaobjectDefinitionByType.fieldDefinitions,
    filledSpecs,
  );

  if (!fields.length) return [];

  const data = await shopifyGraphql<{
    metaobjectCreate: {
      metaobject: { id: string } | null;
      userErrors: Array<{ message: string }>;
    };
  }>(admin, METAOBJECT_CREATE, {
    metaobject: {
      type: typeFromDefinition,
      handle: `${slugifyHandle(sku).replace(/-/g, "_")}_specifiche_prodotto`,
      fields,
    },
  });

  assertNoUserErrors(data.metaobjectCreate.userErrors, "Creazione specifiche prodotto");

  const createdId = data.metaobjectCreate.metaobject?.id;
  if (!createdId) {
    throw new Error("Shopify non ha creato la voce specifiche prodotto.");
  }

  await setProductMetafields(admin, [
    {
      ownerId: productId,
      namespace: "custom",
      key: "product_specs",
      type: metafieldDefinition.type.name,
      value: metafieldDefinition.type.name.startsWith("list.")
        ? JSON.stringify([createdId])
        : createdId,
    },
  ]);

  return [createdId];
}

function buildProductSpecsFields(
  definitionFields: { key: string }[],
  specs: ProductSpecInput[],
) {
  const specByNormalizedTitle = new Map(
    specs.map((spec) => [normalizeSpecKey(spec.title), spec.value?.trim() ?? ""]),
  );

  return definitionFields.flatMap((field) => {
    const value = specByNormalizedTitle.get(normalizeSpecKey(field.key));
    return value ? [{ key: field.key, value }] : [];
  });
}

function normalizeSpecKey(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}
