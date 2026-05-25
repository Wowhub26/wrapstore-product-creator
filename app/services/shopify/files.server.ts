import { dataUrlToUpload } from "../../lib/product-creator";
import { assertNoUserErrors, shopifyGraphql, type ShopifyAdminClient } from "./common.server";

const STAGED_UPLOADS_CREATE = `#graphql
  mutation GuidedProductStagedUploadsCreate($input: [StagedUploadInput!]!) {
    stagedUploadsCreate(input: $input) {
      stagedTargets {
        url
        resourceUrl
        parameters {
          name
          value
        }
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

const FILE_CREATE = `#graphql
  mutation GuidedProductFileCreate($files: [FileCreateInput!]!) {
    fileCreate(files: $files) {
      files {
        id
        alt
        fileStatus
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

const FILE_STATUS_QUERY = `#graphql
  query GuidedProductFileStatus($id: ID!) {
    node(id: $id) {
      ... on GenericFile {
        id
        fileStatus
        url
      }
      ... on MediaImage {
        id
        fileStatus
        image {
          url
        }
      }
    }
  }
`;

export type StagedUploadResult = {
  resourceUrl: string;
  uploadUrl: string;
};

export async function stagedUploadFromDataUrl(
  admin: ShopifyAdminClient,
  file: { fileName: string; mimeType: string; dataUrl?: string },
  resource: "IMAGE" | "FILE",
): Promise<StagedUploadResult> {
  if (!file.dataUrl) {
    throw new Error(`File ${file.fileName} non disponibile: ricarica il file prima di salvare.`);
  }

  const data = await shopifyGraphql<{
    stagedUploadsCreate: {
      stagedTargets: Array<{
        url: string;
        resourceUrl: string;
        parameters: Array<{ name: string; value: string }>;
      }>;
      userErrors: Array<{ message: string }>;
    };
  }>(admin, STAGED_UPLOADS_CREATE, {
    input: [
      {
        filename: file.fileName,
        mimeType: file.mimeType,
        resource,
        httpMethod: "POST",
      },
    ],
  });

  assertNoUserErrors(data.stagedUploadsCreate.userErrors, "Preparazione upload file");
  const target = data.stagedUploadsCreate.stagedTargets[0];
  if (!target) throw new Error("Shopify non ha restituito un URL di upload.");

  const uploadForm = new FormData();
  target.parameters.forEach((parameter) => {
    uploadForm.append(parameter.name, parameter.value);
  });
  uploadForm.append("file", dataUrlToUpload(file.dataUrl, file.fileName, file.mimeType));

  const uploadResponse = await fetch(target.url, {
    method: "POST",
    body: uploadForm,
  });

  if (!uploadResponse.ok) {
    throw new Error(`Upload ${file.fileName} fallito (${uploadResponse.status}).`);
  }

  return {
    uploadUrl: target.url,
    resourceUrl: target.resourceUrl,
  };
}

export async function createShopifyFile(
  admin: ShopifyAdminClient,
  file: { fileName: string; mimeType: string; dataUrl?: string },
  alt: string,
) {
  const staged = await stagedUploadFromDataUrl(admin, file, "FILE");
  const data = await shopifyGraphql<{
    fileCreate: {
      files: Array<{ id: string; fileStatus: string }>;
      userErrors: Array<{ message: string }>;
    };
  }>(admin, FILE_CREATE, {
    files: [
      {
        originalSource: staged.resourceUrl,
        contentType: "FILE",
        alt,
      },
    ],
  });

  assertNoUserErrors(data.fileCreate.userErrors, "Creazione file Shopify");
  const createdFile = data.fileCreate.files[0];
  if (!createdFile) throw new Error("Shopify non ha creato il file.");

  await waitForFileReady(admin, createdFile.id);
  return createdFile.id;
}

export async function waitForFileReady(
  admin: ShopifyAdminClient,
  id: string,
  options = { attempts: 12, delayMs: 1500 },
) {
  for (let attempt = 0; attempt < options.attempts; attempt += 1) {
    const data = await shopifyGraphql<{
      node: { fileStatus?: string } | null;
    }>(admin, FILE_STATUS_QUERY, { id });

    if (data.node?.fileStatus === "READY") return;
    if (data.node?.fileStatus === "FAILED") {
      throw new Error(`Il file ${id} e stato rifiutato da Shopify.`);
    }

    await new Promise((resolve) => setTimeout(resolve, options.delayMs));
  }

  throw new Error(`Timeout aspettando lo stato READY del file ${id}.`);
}
