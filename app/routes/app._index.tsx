import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import {
  ACCEPTED_IMAGE_TYPES,
  generateFilmVariants,
  normalizeColorNameFromFilename,
  productCreatorPayloadSchema,
  type ColorImageInput,
  type HeightInput,
  type ProductCreatorPayload,
  type ProductSpecInput,
} from "../lib/product-creator";
import { getCollections, type ShopifyCollection } from "../services/shopify/collections.server";
import { getHeightOptions } from "../services/shopify/metaobjects.server";
import { createGuidedProduct, type CreateProductResult } from "../services/shopify/products.server";
import { createStagedUploadTargets } from "../services/shopify/files.server";
import { logOperation } from "../services/operation-log.server";

type LoaderData = {
  collections: ShopifyCollection[];
  heights: HeightInput[];
  heightError?: string;
  draft: ProductCreatorPayload | null;
  draftId?: string;
  limits: {
    maxImages: number;
    maxPdfMb: number;
  };
};

type ActionResponse = {
  ok: boolean;
  errors?: string[];
  draftId?: string;
  result?: CreateProductResult;
  uploadTargets?: PreparedUploadTarget[];
};

type PreparedUploadTarget = {
  key: string;
  url: string;
  resourceUrl: string;
  parameters: Array<{ name: string; value: string }>;
};

type ClientUploadItem = {
  key: string;
  fileName: string;
  mimeType: string;
  resource: "IMAGE" | "FILE";
  file: File;
};

const SPEC_FIELDS: ProductSpecInput[] = [
  { key: "materiale", title: "Materiale", value: "" },
  { key: "finitura", title: "Finitura", value: "" },
  { key: "spessore", title: "Spessore", value: "" },
  { key: "tipo_adesivo", title: "Tipo di adesivo", value: "" },
  { key: "metodo_applicazione", title: "Metodo di applicazione", value: "" },
];

const INDEX_ACTION_URL = "/app?index";

const EMPTY_PAYLOAD: ProductCreatorPayload = {
  collectionId: "",
  collectionTitle: "",
  collectionType: "",
  title: "",
  category: "Pellicole",
  brand: "",
  publishNow: false,
  images: [],
  heights: [],
  pdf: null,
  specs: SPEC_FIELDS,
  accessorySku: "",
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const [collections, latestDraft] = await Promise.all([
    getCollections(admin),
    prisma.productDraft.findFirst({
      where: { shop: session.shop },
      orderBy: { updatedAt: "desc" },
      include: { images: { orderBy: { position: "asc" } } },
    }),
  ]);

  let heights: HeightInput[] = [];
  let heightError: string | undefined;
  try {
    heights = await getHeightOptions(admin);
  } catch (error) {
    heightError = error instanceof Error ? error.message : "Errore recuperando le altezze.";
  }

  const draft = latestDraft?.payload
    ? normalizeDraftHeights(latestDraft.payload as ProductCreatorPayload, heights)
    : null;

  return {
    collections,
    heights,
    heightError,
    draft,
    draftId: latestDraft?.id,
    limits: {
      maxImages: Number(process.env.MAX_PRODUCT_IMAGES ?? 24),
      maxPdfMb: Number(process.env.MAX_PRODUCT_PDF_MB ?? 20),
    },
  } satisfies LoaderData;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  try {
    const contentType = request.headers.get("content-type") ?? "";

    if (contentType.includes("multipart/form-data")) {
      const formData = await request.formData();
      const intent = String(formData.get("intent") ?? "");
      const payload = JSON.parse(String(formData.get("payload") ?? "{}")) as ProductCreatorPayload;
      const draftId = String(formData.get("draftId") ?? "") || undefined;

      if (intent !== "createProduct") {
        return { ok: false, errors: ["Azione multipart non riconosciuta."] } satisfies ActionResponse;
      }

      const imageFiles = new Map<string, File>();
      formData.forEach((value, key) => {
        if (key.startsWith("image:") && value instanceof File) {
          imageFiles.set(key.replace("image:", ""), value);
        }
      });
      const pdfValue = formData.get("pdf");
      const pdf = pdfValue instanceof File && pdfValue.size > 0 ? pdfValue : undefined;

      const limitErrors = validateUploadLimits(payload);
      if (limitErrors.length) {
        return { ok: false, errors: limitErrors } satisfies ActionResponse;
      }

      const result = await createGuidedProduct(admin, session.shop, payload, {
        images: imageFiles,
        pdf,
      });

      if (payload.draftId || draftId) {
        await saveDraft(session.shop, { ...payload, draftId: payload.draftId || draftId }, draftId);
      }

      return { ok: result.ok, result, errors: result.ok ? undefined : result.failures } satisfies ActionResponse;
    }

    const body = await request.json();
    const intent = String(body.intent ?? "");
    const payload = body.payload as ProductCreatorPayload | undefined;

    if (intent === "prepareUploads") {
      const files = (body.files ?? []) as Array<{
        key: string;
        fileName: string;
        mimeType: string;
        resource: "IMAGE" | "FILE";
      }>;
      const targets = await createStagedUploadTargets(admin, files);
      return {
        ok: true,
        uploadTargets: targets.map((target, index) => ({
          key: files[index].key,
          ...target,
        })),
      } satisfies ActionResponse;
    }

    if (!payload) {
      return { ok: false, errors: ["Payload mancante."] } satisfies ActionResponse;
    }

    if (intent === "saveDraft") {
      const draftId = await saveDraft(session.shop, payload, body.draftId);
      return { ok: true, draftId } satisfies ActionResponse;
    }

    if (intent === "createProduct") {
      const limitErrors = validateUploadLimits(payload);
      if (limitErrors.length) {
        return { ok: false, errors: limitErrors } satisfies ActionResponse;
      }

      const uploadedResources = body.uploadedResources as
        | {
            images?: Array<{ id: string; resourceUrl: string }>;
            pdf?: { resourceUrl: string };
          }
        | undefined;
      const imageResources = new Map(
        uploadedResources?.images?.map((image) => [image.id, image.resourceUrl]) ?? [],
      );

      const result = await createGuidedProduct(
        admin,
        session.shop,
        payload,
        {},
        {
          images: imageResources,
          pdf: uploadedResources?.pdf?.resourceUrl,
        },
      );
      if (payload.draftId || body.draftId) {
        await saveDraft(session.shop, { ...payload, draftId: payload.draftId || body.draftId }, body.draftId);
      }
      return { ok: result.ok, result, errors: result.ok ? undefined : result.failures } satisfies ActionResponse;
    }

    return { ok: false, errors: ["Azione non riconosciuta."] } satisfies ActionResponse;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Errore imprevisto durante l'operazione.";
    await safeLogActionError(session.shop, message, error);
    console.error("Product creator action failed", error);
    return {
      ok: false,
      errors: [message],
    } satisfies ActionResponse;
  }
};

export default function NewProductWizard() {
  const { collections, heights, heightError, draft, draftId, limits } =
    useLoaderData() as LoaderData;
  const shopify = useAppBridge();
  const [payload, setPayload] = useState<ProductCreatorPayload>({
    ...EMPTY_PAYLOAD,
    ...(draft ?? {}),
    draftId,
    specs: mergeSpecs(draft?.specs),
  });
  const [step, setStep] = useState(0);
  const [search, setSearch] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const [result, setResult] = useState<CreateProductResult | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isAutosaving, setIsAutosaving] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const pdfInputRef = useRef<HTMLInputElement | null>(null);
  const imageFilesRef = useRef<Map<string, File>>(new Map());
  const pdfFileRef = useRef<File | null>(null);

  const selectedCollection = collections.find(
    (collection) => collection.id === payload.collectionId,
  );
  const filteredCollections = collections.filter((collection) =>
    collection.title.toLowerCase().includes(search.toLowerCase()),
  );
  const variants = useMemo(
    () =>
      payload.category === "Pellicole"
        ? generateFilmVariants(payload.images, payload.heights)
        : [],
    [payload.category, payload.images, payload.heights],
  );

  useEffect(() => {
    const timeout = window.setTimeout(async () => {
      if (!payload.title && !payload.collectionId && !payload.images.length) return;
      setIsAutosaving(true);
      try {
        const response = await postJson<ActionResponse>(INDEX_ACTION_URL, {
          intent: "saveDraft",
          draftId: payload.draftId,
          payload: stripBinaryData(payload),
        });
        if (response.draftId && response.draftId !== payload.draftId) {
          setPayload((current) => ({ ...current, draftId: response.draftId }));
        }
      } finally {
        setIsAutosaving(false);
      }
    }, 900);

    return () => window.clearTimeout(timeout);
  }, [payload]);

  const setField = <TKey extends keyof ProductCreatorPayload>(
    key: TKey,
    value: ProductCreatorPayload[TKey],
  ) => {
    setPayload((current) => ({ ...current, [key]: value }));
  };

  const chooseCollection = (collectionId: string) => {
    const collection = collections.find((item) => item.id === collectionId);
    setPayload((current) => ({
      ...current,
      collectionId,
      collectionTitle: collection?.title ?? "",
      collectionType: collection?.type ?? "",
    }));
  };

  const addImages = async (files: FileList | File[]) => {
    const nextFiles = [...files].slice(0, limits.maxImages - payload.images.length);
    const acceptedImageTypes: readonly string[] = ACCEPTED_IMAGE_TYPES;
    const invalid = nextFiles.filter((file) => !acceptedImageTypes.includes(file.type));
    if (invalid.length) {
      setErrors([`Formato immagine non valido: ${invalid.map((file) => file.name).join(", ")}.`]);
      return;
    }

    const images = await Promise.all(
      nextFiles.map(async (file, index) => {
        const id = crypto.randomUUID();
        imageFilesRef.current.set(id, file);
        return {
          id,
          fileName: file.name,
          mimeType: file.type,
          size: file.size,
          dataUrl: await readFileAsDataUrl(file),
          colorName: normalizeColorNameFromFilename(file.name),
          colorSku: "",
          position: payload.images.length + index,
        };
      }),
    );

    setPayload((current) => ({ ...current, images: [...current.images, ...images] }));
    setErrors([]);
  };

  const updateImage = (id: string | undefined, patch: Partial<ColorImageInput>) => {
    setPayload((current) => ({
      ...current,
      images: current.images.map((image) =>
        image.id === id ? { ...image, ...patch } : image,
      ),
    }));
  };

  const removeImage = (id: string | undefined) => {
    if (id) imageFilesRef.current.delete(id);
    setPayload((current) => ({
      ...current,
      images: current.images.filter((image) => image.id !== id),
    }));
  };

  const setPdf = async (file: File | undefined) => {
    if (!file) return;
    if (file.type !== "application/pdf") {
      setErrors(["Il file info prodotto deve essere un PDF."]);
      return;
    }
    if (file.size > limits.maxPdfMb * 1024 * 1024) {
      setErrors([`Il PDF supera il limite di ${limits.maxPdfMb} MB.`]);
      return;
    }

    const dataUrl = await readFileAsDataUrl(file);
    pdfFileRef.current = file;
    setPayload((current) => ({
      ...current,
      pdf: {
        fileName: file.name,
        mimeType: file.type,
        size: file.size,
        dataUrl,
      },
    }));
    setErrors([]);
  };

  const validateCurrent = () => {
    const parsed = productCreatorPayloadSchema.safeParse(payload);
    const nextErrors = parsed.success
      ? []
      : parsed.error.issues.map((issue) => issue.message);
    setErrors(nextErrors);
    return nextErrors.length === 0;
  };

  const goNext = () => {
    if (step >= 4 || validateStep(step, payload)) {
      setErrors([]);
      setStep((current) => Math.min(current + 1, steps.length - 1));
      return;
    }
    setErrors(stepErrors(step, payload));
  };

  const createProduct = async () => {
    if (!validateCurrent()) return;
    setIsSaving(true);
    setResult(null);
    try {
      const response = await postCreateProductWithDirectUploads(
        stripBinaryData(payload),
        imageFilesRef.current,
        pdfFileRef.current,
      );
      if (response.errors?.length) setErrors(response.errors);
      if (response.result) {
        setResult(response.result);
        shopify.toast.show(response.result.message);
      }
    } catch (error) {
      setErrors([
        error instanceof Error
          ? error.message
          : "Errore durante la creazione del prodotto.",
      ]);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <s-page heading="Nuovo prodotto">
      <style>{styles}</style>

      <div className="creator">
        <header className="creator__header">
          <div>
            <p className="eyebrow">Wrapstore product creator</p>
            <h1>Nuovo prodotto guidato</h1>
          </div>
          <span className="autosave">
            {isAutosaving ? "Salvataggio bozza..." : payload.draftId ? "Bozza salvata" : "Nuova bozza"}
          </span>
        </header>

        <nav className="steps" aria-label="Avanzamento wizard">
          {steps.map((label, index) => (
            <button
              className={index === step ? "is-active" : ""}
              key={label}
              onClick={() => setStep(index)}
              type="button"
            >
              <span>{index + 1}</span>
              {label}
            </button>
          ))}
        </nav>

        {errors.length ? (
          <div className="notice notice--error">
            {errors.map((error) => (
              <p key={error}>{error}</p>
            ))}
          </div>
        ) : null}

        {result ? (
          <div className={result.partial ? "notice notice--warning" : "notice notice--success"}>
            <p>{result.message}</p>
            {result.productAdminUrl ? (
              <a href={result.productAdminUrl} target="_blank" rel="noreferrer">
                Apri prodotto in Shopify
              </a>
            ) : null}
            {result.failures.map((failure) => (
              <p key={failure}>{failure}</p>
            ))}
          </div>
        ) : null}

        <section className="panel">
          {step === 0 ? (
            <div className="stack">
              <h2>Scelta collezione</h2>
              <input
                aria-label="Cerca collezione"
                onChange={(event) => setSearch(event.currentTarget.value)}
                placeholder="Cerca collezione"
                type="search"
                value={search}
              />
              <select
                onChange={(event) => chooseCollection(event.currentTarget.value)}
                value={payload.collectionId}
              >
                <option value="">Seleziona una collezione</option>
                {filteredCollections.map((collection) => (
                  <option key={collection.id} value={collection.id}>
                    {collection.title} {collection.type === "SMART" ? "(automatica)" : ""}
                  </option>
                ))}
              </select>
              {selectedCollection?.type === "SMART" ? (
                <div className="notice notice--warning">
                  Questa collezione e automatica: Shopify potrebbe rifiutare la aggiunta
                  manuale del prodotto. Se accade, il prodotto restera creato come bozza.
                </div>
              ) : null}
            </div>
          ) : null}

          {step === 1 ? (
            <div className="grid grid--two">
              <label>
                Titolo prodotto
                <input
                  onChange={(event) => setField("title", event.currentTarget.value)}
                  placeholder="Es. Pellicola Rosso Mattone"
                  value={payload.title}
                />
              </label>
              <label>
                Brand
                <input
                  onChange={(event) => setField("brand", event.currentTarget.value)}
                  placeholder="Es. Wrapstore"
                  value={payload.brand ?? ""}
                />
              </label>
              <label>
                Categoria prodotto interna
                <select
                  onChange={(event) =>
                    setField("category", event.currentTarget.value as "Pellicole" | "Accessori")
                  }
                  value={payload.category}
                >
                  <option>Pellicole</option>
                  <option>Accessori</option>
                </select>
              </label>
              <label className="check">
                <input
                  checked={Boolean(payload.publishNow)}
                  onChange={(event) => setField("publishNow", event.currentTarget.checked)}
                  type="checkbox"
                />
                Pubblica subito invece di creare in bozza
              </label>
            </div>
          ) : null}

          {step === 2 && payload.category === "Pellicole" ? (
            <FilmStep
              fileInputRef={fileInputRef}
              heightError={heightError}
              heights={heights}
              limits={limits}
              onAddImages={addImages}
              onRemoveImage={removeImage}
              onSetHeights={(selected) => setField("heights", selected)}
              onUpdateImage={updateImage}
              payload={payload}
            />
          ) : null}

          {step === 2 && payload.category === "Accessori" ? (
            <AccessoryStep
              fileInputRef={fileInputRef}
              limits={limits}
              onAddImages={addImages}
              onRemoveImage={removeImage}
              onUpdateImage={updateImage}
              payload={payload}
              setPayload={setPayload}
            />
          ) : null}

          {step === 3 ? (
            <div className="stack">
              <h2>File e specifiche prodotto</h2>
              <div className="upload-row">
                <input
                  accept="application/pdf"
                  hidden
                  onChange={(event) => setPdf(event.currentTarget.files?.[0])}
                  ref={pdfInputRef}
                  type="file"
                />
                <button onClick={() => pdfInputRef.current?.click()} type="button">
                  Carica PDF info prodotto
                </button>
                <span>{payload.pdf?.fileName ?? "Nessun PDF selezionato"}</span>
              </div>

              {payload.category === "Pellicole" ? (
                <div className="grid grid--two">
                  {payload.specs.map((spec) => (
                    <label key={spec.key}>
                      {spec.title}
                      <input
                        onChange={(event) =>
                          setField(
                            "specs",
                            payload.specs.map((item) =>
                              item.key === spec.key
                                ? { ...item, value: event.currentTarget.value }
                                : item,
                            ),
                          )
                        }
                        value={spec.value ?? ""}
                      />
                    </label>
                  ))}
                </div>
              ) : (
                <p className="muted">
                  Gli accessori usano per ora titolo, brand, immagini, SKU opzionale e PDF.
                </p>
              )}
            </div>
          ) : null}

          {step === 4 ? (
            <Review
              payload={payload}
              selectedCollection={selectedCollection}
              variants={variants}
            />
          ) : null}
        </section>

        <footer className="actions">
          <button disabled={step === 0} onClick={() => setStep((current) => current - 1)} type="button">
            Indietro
          </button>
          {step < steps.length - 1 ? (
            <button className="primary" onClick={goNext} type="button">
              Continua
            </button>
          ) : (
            <button className="primary" disabled={isSaving} onClick={createProduct} type="button">
              {isSaving ? "Creazione in corso..." : "Crea prodotto"}
            </button>
          )}
        </footer>
      </div>
    </s-page>
  );
}

function FilmStep({
  fileInputRef,
  heightError,
  heights,
  limits,
  onAddImages,
  onRemoveImage,
  onSetHeights,
  onUpdateImage,
  payload,
}: {
  fileInputRef: React.MutableRefObject<HTMLInputElement | null>;
  heightError?: string;
  heights: HeightInput[];
  limits: LoaderData["limits"];
  onAddImages: (files: FileList | File[]) => void;
  onRemoveImage: (id?: string) => void;
  onSetHeights: (heights: HeightInput[]) => void;
  onUpdateImage: (id: string | undefined, patch: Partial<ColorImageInput>) => void;
  payload: ProductCreatorPayload;
}) {
  return (
    <div className="stack">
      <h2>Configurazione Pellicole</h2>
      <DropZone fileInputRef={fileInputRef} limits={limits} onAddImages={onAddImages} />
      <ImageRows images={payload.images} onRemove={onRemoveImage} onUpdate={onUpdateImage} />

      <label>
        Altezza
        <div className="height-options" role="group" aria-label="Altezze disponibili">
          {heights.length ? (
            heights.map((height) => {
              const selected = payload.heights.some((item) => item.id === height.id);
              return (
                <button
                  aria-pressed={selected}
                  className={selected ? "height-option is-selected" : "height-option"}
                  key={height.id}
                  onClick={() => {
                    onSetHeights(
                      selected
                        ? payload.heights.filter((item) => item.id !== height.id)
                        : [...payload.heights, height],
                    );
                  }}
                  type="button"
                >
                  {height.label}
                </button>
              );
            })
          ) : (
            <p className="empty">Nessuna altezza disponibile.</p>
          )}
        </div>
      </label>
      {heightError ? <div className="notice notice--error">{heightError}</div> : null}
    </div>
  );
}

function AccessoryStep({
  fileInputRef,
  limits,
  onAddImages,
  onRemoveImage,
  onUpdateImage,
  payload,
  setPayload,
}: {
  fileInputRef: React.MutableRefObject<HTMLInputElement | null>;
  limits: LoaderData["limits"];
  onAddImages: (files: FileList | File[]) => void;
  onRemoveImage: (id?: string) => void;
  onUpdateImage: (id: string | undefined, patch: Partial<ColorImageInput>) => void;
  payload: ProductCreatorPayload;
  setPayload: React.Dispatch<React.SetStateAction<ProductCreatorPayload>>;
}) {
  return (
    <div className="stack">
      <h2>Accessori</h2>
      <label>
        SKU opzionale
        <input
          onChange={(event) =>
            setPayload((current) => ({ ...current, accessorySku: event.currentTarget.value }))
          }
          value={payload.accessorySku ?? ""}
        />
      </label>
      <DropZone fileInputRef={fileInputRef} limits={limits} onAddImages={onAddImages} />
      <ImageRows images={payload.images} onRemove={onRemoveImage} onUpdate={onUpdateImage} />
    </div>
  );
}

function DropZone({
  fileInputRef,
  limits,
  onAddImages,
}: {
  fileInputRef: React.MutableRefObject<HTMLInputElement | null>;
  limits: LoaderData["limits"];
  onAddImages: (files: FileList | File[]) => void;
}) {
  return (
    <div
      className="dropzone"
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        onAddImages(event.dataTransfer.files);
      }}
    >
      <input
        accept="image/png,image/jpeg,image/webp"
        hidden
        multiple
        onChange={(event) => event.currentTarget.files && onAddImages(event.currentTarget.files)}
        ref={fileInputRef}
        type="file"
      />
      <button onClick={() => fileInputRef.current?.click()} type="button">
        Carica immagini
      </button>
      <span>PNG, JPG o WEBP. Massimo {limits.maxImages} immagini.</span>
    </div>
  );
}

function ImageRows({
  images,
  onRemove,
  onUpdate,
}: {
  images: ColorImageInput[];
  onRemove: (id?: string) => void;
  onUpdate: (id: string | undefined, patch: Partial<ColorImageInput>) => void;
}) {
  if (!images.length) return <p className="empty">Nessuna immagine caricata.</p>;

  return (
    <div className="image-list">
      {images.map((image) => (
        <div className="image-row" key={image.id ?? image.fileName}>
          {image.dataUrl ? <img alt={image.colorName} src={image.dataUrl} /> : <div />}
          <label>
            Nome colore
            <input
              onChange={(event) => onUpdate(image.id, { colorName: event.currentTarget.value })}
              value={image.colorName}
            />
          </label>
          <label>
            SKU colore
            <input
              onChange={(event) => onUpdate(image.id, { colorSku: event.currentTarget.value })}
              value={image.colorSku ?? ""}
            />
          </label>
          <button onClick={() => onRemove(image.id)} type="button">
            Rimuovi
          </button>
        </div>
      ))}
    </div>
  );
}

function Review({
  payload,
  selectedCollection,
  variants,
}: {
  payload: ProductCreatorPayload;
  selectedCollection?: ShopifyCollection;
  variants: ReturnType<typeof generateFilmVariants>;
}) {
  return (
    <div className="review">
      <h2>Review finale</h2>
      <dl>
        <dt>Collezione</dt>
        <dd>{selectedCollection?.title ?? "Non selezionata"}</dd>
        <dt>Titolo</dt>
        <dd>{payload.title || "Senza titolo"}</dd>
        <dt>Categoria</dt>
        <dd>{payload.category}</dd>
        <dt>Brand</dt>
        <dd>{payload.brand || "-"}</dd>
        <dt>Colori</dt>
        <dd>{payload.images.map((image) => image.colorName).join(", ") || "-"}</dd>
        <dt>Altezze</dt>
        <dd>{payload.heights.map((height) => height.label).join(", ") || "-"}</dd>
        <dt>Varianti</dt>
        <dd>{variants.length ? `${variants.length} varianti` : "Nessuna variante dedicata"}</dd>
        <dt>PDF</dt>
        <dd>{payload.pdf?.fileName ?? "-"}</dd>
        <dt>Specifiche</dt>
        <dd>
          {payload.specs
            .filter((spec) => spec.value)
            .map((spec) => `${spec.title}: ${spec.value}`)
            .join(", ") || "-"}
        </dd>
      </dl>
      {variants.length ? (
        <table>
          <thead>
            <tr>
              <th>Colore</th>
              <th>Altezza</th>
              <th>SKU</th>
            </tr>
          </thead>
          <tbody>
            {variants.map((variant) => (
              <tr key={`${variant.colorName}-${variant.heightLabel}`}>
                <td>{variant.colorName}</td>
                <td>{variant.heightLabel}</td>
                <td>{variant.sku || "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}

function mergeSpecs(specs?: ProductSpecInput[]) {
  return SPEC_FIELDS.map((field) => ({
    ...field,
    value: specs?.find((spec) => spec.key === field.key)?.value ?? "",
  }));
}

function normalizeDraftHeights(
  draft: ProductCreatorPayload,
  availableHeights: HeightInput[],
): ProductCreatorPayload {
  if (!draft.heights?.length || !availableHeights.length) return draft;

  return {
    ...draft,
    heights: draft.heights.map((selected) => {
      const current = availableHeights.find((height) => height.id === selected.id);
      return current ?? selected;
    }),
  };
}

function validateStep(step: number, payload: ProductCreatorPayload) {
  return stepErrors(step, payload).length === 0;
}

function stepErrors(step: number, payload: ProductCreatorPayload) {
  if (step === 0 && !payload.collectionId) return ["Seleziona una collezione."];
  if (step === 1 && !payload.title.trim()) return ["Inserisci il titolo prodotto."];
  if (step === 2 && payload.category === "Pellicole") {
    const errors: string[] = [];
    if (!payload.images.length) errors.push("Carica almeno una immagine.");
    if (!payload.heights.length) errors.push("Seleziona almeno una altezza.");
    return errors;
  }
  return [];
}

function validateUploadLimits(payload: ProductCreatorPayload) {
  const errors: string[] = [];
  const maxImages = Number(process.env.MAX_PRODUCT_IMAGES ?? 24);
  const maxPdfMb = Number(process.env.MAX_PRODUCT_PDF_MB ?? 20);
  if (payload.images.length > maxImages) errors.push(`Massimo ${maxImages} immagini.`);
  if (payload.pdf && payload.pdf.size > maxPdfMb * 1024 * 1024) {
    errors.push(`Il PDF supera il limite di ${maxPdfMb} MB.`);
  }
  return errors;
}

async function saveDraft(shop: string, payload: ProductCreatorPayload, draftId?: string) {
  const existing = draftId
    ? await prisma.productDraft.findFirst({ where: { id: draftId, shop } })
    : null;
  const data = {
    shop,
    title: payload.title || null,
    category: payload.category,
    brand: payload.brand || null,
    collectionId: payload.collectionId || null,
    collectionTitle: payload.collectionTitle || null,
    collectionType: payload.collectionType || null,
    publishNow: Boolean(payload.publishNow),
    selectedHeights: payload.heights,
    specs: payload.specs,
    accessorySku: payload.accessorySku || null,
    pdfFileName: payload.pdf?.fileName ?? null,
    pdfMimeType: payload.pdf?.mimeType ?? null,
    pdfSize: payload.pdf?.size ?? null,
    pdfDataUrl: payload.pdf?.dataUrl ?? null,
    payload,
  };

  const draft = existing
    ? await prisma.productDraft.update({
        where: { id: existing.id },
        data: {
          ...data,
          images: {
            deleteMany: {},
            create: payload.images.map((image, index) => ({
              fileName: image.fileName,
              mimeType: image.mimeType,
              size: image.size,
              colorName: image.colorName,
              colorSku: image.colorSku || null,
              previewDataUrl: image.dataUrl ?? null,
              position: index,
            })),
          },
        },
      })
    : await prisma.productDraft.create({
        data: {
          ...data,
          images: {
            create: payload.images.map((image, index) => ({
              fileName: image.fileName,
              mimeType: image.mimeType,
              size: image.size,
              colorName: image.colorName,
              colorSku: image.colorSku || null,
              previewDataUrl: image.dataUrl ?? null,
              position: index,
            })),
          },
        },
      });

  return draft.id;
}

async function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(file);
  });
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      text.trim() || `Richiesta fallita (${response.status}). Riprova o controlla i log Render.`,
    );
  }

  return response.json();
}

async function safeLogActionError(shop: string, message: string, error: unknown) {
  try {
    await logOperation({
      shop,
      operation: "product_creator:action_error",
      status: "ERROR",
      userMessage: message,
      technicalDetail: serializeError(error),
    });
  } catch (logError) {
    console.error("OperationLog failed", logError);
  }
}

function serializeError(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  return { message: String(error) };
}

async function postCreateProductWithDirectUploads(
  payload: ProductCreatorPayload,
  imageFiles: Map<string, File>,
  pdfFile: File | null,
): Promise<ActionResponse> {
  const uploadItems: ClientUploadItem[] = payload.images.flatMap((image) => {
    if (!image.id) return [];
    const file = imageFiles.get(image.id);
    return file
      ? [{ key: `image:${image.id}`, fileName: image.fileName, mimeType: image.mimeType, resource: "IMAGE" as const, file }]
      : [];
  });

  if (pdfFile && payload.pdf) {
    uploadItems.push({
      key: "pdf",
      fileName: payload.pdf.fileName,
      mimeType: payload.pdf.mimeType,
      resource: "FILE" as const,
      file: pdfFile,
    });
  }

  const prepareResponse = await postJson<ActionResponse>(INDEX_ACTION_URL, {
    intent: "prepareUploads",
    files: uploadItems.map((item) => ({
      key: item.key,
      fileName: item.fileName,
      mimeType: item.mimeType,
      resource: item.resource,
    })),
  });

  const targets = prepareResponse.uploadTargets ?? [];
  if (targets.length !== uploadItems.length) {
    throw new Error("Shopify non ha preparato tutti gli upload richiesti.");
  }

  await Promise.all(
    uploadItems.map(async (item) => {
      const target = targets.find((uploadTarget) => uploadTarget.key === item.key);
      if (!target) throw new Error(`Upload non preparato per ${item.fileName}.`);

      const formData = new FormData();
      target.parameters.forEach((parameter) => {
        formData.append(parameter.name, parameter.value);
      });
      formData.append("file", item.file);

      const uploadResponse = await fetch(target.url, {
        method: "POST",
        body: formData,
      });

      if (!uploadResponse.ok) {
        throw new Error(`Upload ${item.fileName} fallito (${uploadResponse.status}).`);
      }
    }),
  );

  return postJson<ActionResponse>(INDEX_ACTION_URL, {
    intent: "createProduct",
    draftId: payload.draftId,
    payload,
    uploadedResources: {
      images: targets
        .filter((target) => target.key.startsWith("image:"))
        .map((target) => ({
          id: target.key.replace("image:", ""),
          resourceUrl: target.resourceUrl,
        })),
      pdf: targets.find((target) => target.key === "pdf")
        ? { resourceUrl: targets.find((target) => target.key === "pdf")!.resourceUrl }
        : undefined,
    },
  });
}

function stripBinaryData(payload: ProductCreatorPayload): ProductCreatorPayload {
  return {
    ...payload,
    images: payload.images.map((image) => ({
      ...image,
      dataUrl: undefined,
    })),
    pdf: payload.pdf
      ? {
          ...payload.pdf,
          dataUrl: undefined,
        }
      : payload.pdf,
  };
}

const steps = ["Collezione", "Base", "Configurazione", "File e specs", "Review"];

const styles = `
  .creator { max-width: 1180px; margin: 0 auto; padding: 18px; color: #202223; }
  .creator__header { display: flex; justify-content: space-between; gap: 16px; align-items: start; margin-bottom: 18px; }
  .creator h1, .creator h2 { margin: 0; letter-spacing: 0; }
  .creator h1 { font-size: 28px; }
  .creator h2 { font-size: 20px; margin-bottom: 14px; }
  .eyebrow { margin: 0 0 4px; font-size: 12px; text-transform: uppercase; color: #616a75; font-weight: 700; }
  .autosave { color: #616a75; font-size: 13px; white-space: nowrap; }
  .steps { display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px; margin-bottom: 16px; }
  .steps button { border: 1px solid #d5d9de; background: #fff; padding: 10px; border-radius: 8px; display: flex; align-items: center; justify-content: center; gap: 8px; font-weight: 650; cursor: pointer; }
  .steps button span { width: 24px; height: 24px; border-radius: 50%; display: inline-grid; place-items: center; background: #eef1f4; }
  .steps button.is-active { border-color: #008060; color: #005e46; background: #f0f8f5; }
  .panel { background: #fff; border: 1px solid #dfe3e8; border-radius: 8px; padding: 20px; min-height: 430px; }
  .stack { display: grid; gap: 16px; }
  .grid { display: grid; gap: 16px; }
  .grid--two { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  label { display: grid; gap: 6px; font-size: 13px; font-weight: 650; color: #3f4750; }
  input, select { width: 100%; border: 1px solid #c9ced6; border-radius: 6px; padding: 10px 12px; font: inherit; background: #fff; box-sizing: border-box; }
  select[multiple] { min-height: 150px; }
  .height-options { border: 1px solid #c9ced6; border-radius: 8px; padding: 10px; display: flex; flex-wrap: wrap; gap: 8px; min-height: 56px; align-items: flex-start; background: #fff; }
  .height-option { border-color: #c9ced6; background: #fff; color: #202223; min-height: 36px; }
  .height-option.is-selected { border-color: #008060; background: #f0f8f5; color: #005e46; box-shadow: inset 0 0 0 1px #008060; }
  .check { align-content: end; grid-template-columns: auto 1fr; align-items: center; }
  .check input { width: auto; }
  .notice { border-radius: 8px; padding: 12px 14px; margin-bottom: 14px; border: 1px solid #c9ced6; background: #f7f8f9; }
  .notice p { margin: 0 0 4px; }
  .notice--error { border-color: #e4a3a3; background: #fff4f4; color: #8a1f1f; }
  .notice--warning { border-color: #e2c078; background: #fff8e5; color: #6d4a00; }
  .notice--success { border-color: #9bd4b8; background: #f0f8f5; color: #005e46; }
  .dropzone { border: 1px dashed #9aa4b2; border-radius: 8px; padding: 22px; display: flex; gap: 12px; align-items: center; background: #fafbfb; }
  button { border: 1px solid #c9ced6; background: #fff; padding: 10px 14px; border-radius: 6px; font-weight: 700; cursor: pointer; }
  button.primary { background: #008060; border-color: #008060; color: #fff; }
  button:disabled { opacity: 0.45; cursor: not-allowed; }
  .image-list { display: grid; gap: 12px; }
  .image-row { display: grid; grid-template-columns: 84px 1fr 180px auto; gap: 12px; align-items: end; padding: 12px; border: 1px solid #e1e5ea; border-radius: 8px; }
  .image-row img, .image-row > div:first-child { width: 84px; height: 84px; object-fit: cover; border-radius: 6px; background: #eef1f4; }
  .upload-row { display: flex; gap: 12px; align-items: center; }
  .review dl { display: grid; grid-template-columns: 160px 1fr; gap: 10px 16px; margin: 0 0 18px; }
  .review dt { font-weight: 750; color: #3f4750; }
  .review dd { margin: 0; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th, td { border-top: 1px solid #e1e5ea; text-align: left; padding: 10px; }
  .actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 16px; }
  .empty, .muted { color: #616a75; margin: 0; }
  @media (max-width: 760px) {
    .creator { padding: 12px; }
    .creator__header { display: grid; }
    .steps { grid-template-columns: 1fr; }
    .grid--two, .image-row { grid-template-columns: 1fr; }
    .image-row img, .image-row > div:first-child { width: 100%; height: auto; aspect-ratio: 4 / 3; }
    .review dl { grid-template-columns: 1fr; }
    .dropzone, .upload-row { align-items: stretch; flex-direction: column; }
  }
`;

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
