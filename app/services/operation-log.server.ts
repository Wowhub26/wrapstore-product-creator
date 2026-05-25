import prisma from "../db.server";

type LogInput = {
  shop: string;
  draftId?: string | null;
  productId?: string | null;
  operation: string;
  status: "SUCCESS" | "ERROR" | "PARTIAL";
  userMessage?: string | null;
  technicalDetail?: unknown;
};

export async function logOperation(input: LogInput) {
  await prisma.operationLog.create({
    data: {
      shop: input.shop,
      draftId: input.draftId ?? null,
      productId: input.productId ?? null,
      operation: input.operation,
      status: input.status,
      userMessage: input.userMessage ?? null,
      technicalDetail: input.technicalDetail ?? undefined,
    },
  });
}
