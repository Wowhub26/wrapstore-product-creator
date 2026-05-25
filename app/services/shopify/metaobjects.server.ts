import {
  resolveProductSpecsMapping,
  specHandle,
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
        code
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
  const metaobjectType =
    process.env.ALTEZZA_METAOBJECT_TYPE ||
    definition?.validations.find((validation) =>
      ["metaobject_definition_type", "metaobject_type"].includes(validation.name),
    )?.value;

  if (!definition) {
    throw new Error(
      "Metafield custom.altezza non trovato. Verifica la definizione nel pannello Shopify.",
    );
  }

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
        value: node.id,
        handle: node.handle,
      })),
    );

    cursor = data.metaobjects.pageInfo.hasNextPage
      ? data.metaobjects.pageInfo.endCursor
      : null;
  } while (cursor);

  return options;
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
    )?.value;

  if (!metafieldDefinition?.type.name.includes("metaobject_reference")) {
    throw new Error(
      "custom.product_specs deve essere una lista di riferimenti metaobject compatibile.",
    );
  }

  if (!typeFromDefinition) {
    throw new Error(
      "Tipo metaobject per custom.product_specs non risolto. Imposta PRODUCT_SPECS_METAOBJECT_TYPE.",
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

  const mapping = resolveProductSpecsMapping(
    definition.metaobjectDefinitionByType.fieldDefinitions,
    process.env,
  );

  const createdIds: string[] = [];

  for (const spec of filledSpecs) {
    const fields = [
      { key: mapping.titleField, value: spec.title },
      { key: mapping.valueField, value: spec.value?.trim() ?? "" },
    ];

    if (mapping.skuField) {
      fields.push({ key: mapping.skuField, value: sku });
    }

    const data = await shopifyGraphql<{
      metaobjectCreate: {
        metaobject: { id: string } | null;
        userErrors: Array<{ message: string }>;
      };
    }>(admin, METAOBJECT_CREATE, {
      metaobject: {
        type: typeFromDefinition,
        handle: specHandle(spec.title, sku),
        fields,
      },
    });

    assertNoUserErrors(data.metaobjectCreate.userErrors, `Creazione specifica ${spec.title}`);

    if (data.metaobjectCreate.metaobject?.id) {
      createdIds.push(data.metaobjectCreate.metaobject.id);
    }
  }

  await setProductMetafields(admin, [
    {
      ownerId: productId,
      namespace: "custom",
      key: "product_specs",
      type: metafieldDefinition.type.name,
      value: JSON.stringify(createdIds),
    },
  ]);

  return createdIds;
}
