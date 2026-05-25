export type ShopifyAdminClient = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
};

export type ShopifyUserError = {
  field?: string[] | string | null;
  message: string;
  code?: string | null;
};

export class ShopifyGraphqlError extends Error {
  details: unknown;

  constructor(message: string, details?: unknown) {
    super(message);
    this.name = "ShopifyGraphqlError";
    this.details = details;
  }
}

export async function shopifyGraphql<TData>(
  admin: ShopifyAdminClient,
  query: string,
  variables?: Record<string, unknown>,
): Promise<TData> {
  const response = await admin.graphql(query, { variables });
  const json: { data?: TData; errors?: ShopifyUserError[] } = await response.json();

  if (json.errors?.length) {
    throw new ShopifyGraphqlError(
      json.errors.map((error) => error.message).join("; "),
      json.errors,
    );
  }

  if (!json.data) {
    throw new ShopifyGraphqlError("Shopify non ha restituito dati.", json);
  }

  return json.data;
}

export function assertNoUserErrors(errors: ShopifyUserError[] | undefined, label: string) {
  if (!errors?.length) return;
  throw new ShopifyGraphqlError(
    `${label}: ${errors.map((error) => error.message).join("; ")}`,
    errors,
  );
}

export function normalizeShopifyError(error: unknown) {
  if (error instanceof ShopifyGraphqlError) {
    return {
      userMessage: error.message,
      technicalDetail: error.details,
    };
  }

  return {
    userMessage: error instanceof Error ? error.message : "Errore Shopify sconosciuto.",
    technicalDetail: error,
  };
}
