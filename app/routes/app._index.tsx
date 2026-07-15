import { useMemo, useRef, useState } from "react";
import type {
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  ACCEPTED_IMAGE_TYPES,
  generateFilmVariants,
  groupImagesByVariantColor,
  isValidHexColor,
  normalizeHexColor,
  normalizeImageTitleFromFilename,
  suggestedHexFromColorName,
  variantColorNameFromImageTitle,
  productCreatorPayloadSchema,
  type ColorImageInput,
  type HeightInput,
  type ProductCreatorPayload,
  type ProductSpecInput,
} from "../lib/product-creator";
import { getCollections, type ShopifyCollection } from "../services/shopify/collections.server";
import { getHeightOptions } from "../services/shopify/metaobjects.server";
import { type CreateProductResult } from "../services/shopify/products.server";

type LoaderData = {
  collections: ShopifyCollection[];
  heights: HeightInput[];
  heightError?: string;
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
  const { admin } = await authenticate.admin(request);
  const collections = await getCollections(admin);

  let heights: HeightInput[] = [];
  let heightError: string | undefined;
  try {
    heights = await getHeightOptions(admin);
  } catch (error) {
    heightError = error instanceof Error ? error.message : "Errore recuperando le altezze.";
  }

  return {
    collections,
    heights,
    heightError,
    limits: {
      maxImages: Number(process.env.MAX_PRODUCT_IMAGES ?? 24),
      maxPdfMb: Number(process.env.MAX_PRODUCT_PDF_MB ?? 20),
    },
  } satisfies LoaderData;
};

export default function NewProductWizard() {
  const { collections, heights, heightError, limits } =
    useLoaderData() as LoaderData;
  const shopify = useAppBridge();
  const [payload, setPayload] = useState<ProductCreatorPayload>({
    ...EMPTY_PAYLOAD,
    specs: mergeSpecs(),
  });
  const [step, setStep] = useState(0);
  const [search, setSearch] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const [result, setResult] = useState<CreateProductResult | null>(null);
  const [isSaving, setIsSaving] = useState(false);
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
        const colorName = normalizeImageTitleFromFilename(file.name);
        const dataUrl = await readFileAsDataUrl(file);
        imageFilesRef.current.set(id, file);
        return {
          id,
          fileName: file.name,
          mimeType: file.type,
          size: file.size,
          dataUrl,
          colorName,
          variantColorName: variantColorNameFromImageTitle(colorName),
          colorHex: await inferSuggestedHexColor(dataUrl, colorName).catch(
            () => suggestedHexFromColorName(colorName) || "",
          ),
          colorSku: "",
          isColorCover: false,
          position: payload.images.length + index,
        };
      }),
    );

    setPayload((current) => ({
      ...current,
      images: ensureColorCovers([...current.images, ...images]),
    }));
    setErrors([]);
  };

  const updateImage = (id: string | undefined, patch: Partial<ColorImageInput>) => {
    setPayload((current) => ({
      ...current,
      images: normalizeImageCoverSelection(
        current.images.map((image) =>
          image.id === id ? { ...image, ...patch } : image,
        ),
        id,
        patch,
      ),
    }));
  };

  const removeImage = (id: string | undefined) => {
    if (id) imageFilesRef.current.delete(id);
    setPayload((current) => ({
      ...current,
      images: ensureColorCovers(current.images.filter((image) => image.id !== id)),
    }));
  };

  const autofillImageHex = async (id: string | undefined) => {
    if (!id) return;
    const image = payload.images.find((item) => item.id === id);
    if (!image?.dataUrl) return;

    const suggestedHex = await inferSuggestedHexColor(
      image.dataUrl,
      image.variantColorName || image.colorName,
    ).catch(() => suggestedHexFromColorName(image.variantColorName || image.colorName) || "");
    if (!suggestedHex) return;
    updateImage(id, { colorHex: suggestedHex });
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
      const sessionToken = await getShopifySessionToken(shopify);
      const response = await postCreateProductWithDirectUploads(
        stripBinaryData(payload),
        imageFilesRef.current,
        pdfFileRef.current,
        sessionToken,
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
          <span className="autosave">Nuovo prodotto</span>
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
              <p className="muted">Il prodotto verra creato sempre come bozza Shopify.</p>
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
              onAutofillHex={autofillImageHex}
              onUpdateImage={updateImage}
              payload={payload}
            />
          ) : null}

          {step === 2 && payload.category === "Accessori" ? (
            <AccessoryStep
              fileInputRef={fileInputRef}
              limits={limits}
              onAddImages={addImages}
              onAutofillHex={autofillImageHex}
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
  onAutofillHex,
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
  onAutofillHex: (id?: string) => void;
  onRemoveImage: (id?: string) => void;
  onSetHeights: (heights: HeightInput[]) => void;
  onUpdateImage: (id: string | undefined, patch: Partial<ColorImageInput>) => void;
  payload: ProductCreatorPayload;
}) {
  return (
    <div className="stack">
      <h2>Configurazione Pellicole</h2>
      <DropZone fileInputRef={fileInputRef} limits={limits} onAddImages={onAddImages} />
      <ImageRows
        images={payload.images}
        onAutofillHex={onAutofillHex}
        onRemove={onRemoveImage}
        onUpdate={onUpdateImage}
      />
      <ColorGroupSummary images={payload.images} />

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
  onAutofillHex,
  onRemoveImage,
  onUpdateImage,
  payload,
  setPayload,
}: {
  fileInputRef: React.MutableRefObject<HTMLInputElement | null>;
  limits: LoaderData["limits"];
  onAddImages: (files: FileList | File[]) => void;
  onAutofillHex: (id?: string) => void;
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
      <ImageRows
        images={payload.images}
        onAutofillHex={onAutofillHex}
        onRemove={onRemoveImage}
        onUpdate={onUpdateImage}
      />
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
  onAutofillHex,
  onRemove,
  onUpdate,
}: {
  images: ColorImageInput[];
  onAutofillHex: (id?: string) => void;
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
            Colore variante
            <input
              onChange={(event) =>
                onUpdate(image.id, { variantColorName: event.currentTarget.value })
              }
              value={image.variantColorName ?? variantColorNameFromImageTitle(image.colorName)}
            />
          </label>
          <label>
            Colore HEX
            <div className="hex-field">
              <span
                aria-hidden="true"
                className="hex-swatch"
                style={{
                  background: isValidHexColor(image.colorHex) ? normalizeHexColor(image.colorHex) : "#FFFFFF",
                }}
              />
              <input
                onChange={(event) =>
                  onUpdate(image.id, { colorHex: normalizeHexColor(event.currentTarget.value) })
                }
                placeholder="#A36B43"
                value={image.colorHex ?? ""}
              />
              <button onClick={() => onAutofillHex(image.id)} type="button">
                Auto
              </button>
            </div>
          </label>
          <label>
            SKU colore
            <input
              onChange={(event) => onUpdate(image.id, { colorSku: event.currentTarget.value })}
              value={image.colorSku ?? ""}
            />
          </label>
          <label className="check image-cover">
            <input
              checked={Boolean(image.isColorCover)}
              onChange={() => onUpdate(image.id, { isColorCover: true })}
              type="radio"
            />
            Copertina colore
          </label>
          <button onClick={() => onRemove(image.id)} type="button">
            Rimuovi
          </button>
        </div>
      ))}
    </div>
  );
}

function ColorGroupSummary({ images }: { images: ColorImageInput[] }) {
  const groups = groupImagesByVariantColor(images);
  if (!groups.length) return null;

  return (
    <div className="color-groups">
      <h3>Colori variante</h3>
      {groups.map((group) => (
        <div className="color-group" key={group.name}>
          <span
            aria-hidden="true"
            className="hex-swatch hex-swatch--small"
            style={{
              background: isValidHexColor(group.cover.colorHex) ? normalizeHexColor(group.cover.colorHex) : "#FFFFFF",
            }}
          />
          <strong>{group.name}</strong>
          <span>{group.images.length} immagini</span>
          <span>{group.cover.colorHex || "HEX non rilevato"}</span>
          <span>Copertina: {group.cover.colorName}</span>
        </div>
      ))}
    </div>
  );
}

function normalizeImageCoverSelection(
  images: ColorImageInput[],
  changedId: string | undefined,
  patch: Partial<ColorImageInput>,
) {
  if (!changedId) return ensureColorCovers(images);
  const changed = images.find((image) => image.id === changedId);
  if (!changed) return ensureColorCovers(images);

  const changedGroup = imageVariantColorName(changed).toLowerCase();
  const normalized = patch.isColorCover
    ? images.map((image) =>
        imageVariantColorName(image).toLowerCase() === changedGroup
          ? { ...image, isColorCover: image.id === changedId }
          : image,
      )
    : images;

  return ensureColorCovers(normalized);
}

function ensureColorCovers(images: ColorImageInput[]) {
  const coveredGroups = new Set(
    images
      .filter((image) => image.isColorCover)
      .map((image) => imageVariantColorName(image).toLowerCase()),
  );

  return images.map((image) => {
    const group = imageVariantColorName(image).toLowerCase();
    if (coveredGroups.has(group)) return image;
    coveredGroups.add(group);
    return { ...image, isColorCover: true };
  });
}

function imageVariantColorName(image: Pick<ColorImageInput, "colorName" | "variantColorName">) {
  return image.variantColorName?.trim() || variantColorNameFromImageTitle(image.colorName);
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
        <dd>{groupImagesByVariantColor(payload.images).map((group) => group.name).join(", ") || "-"}</dd>
        <dt>HEX colori</dt>
        <dd>
          {groupImagesByVariantColor(payload.images)
            .map((group) => `${group.name}: ${group.cover.colorHex || "n/d"}`)
            .join(", ") || "-"}
        </dd>
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
              <th>HEX</th>
              <th>Altezza</th>
              <th>SKU</th>
            </tr>
          </thead>
          <tbody>
            {variants.map((variant) => (
              <tr key={`${variant.colorName}-${variant.heightLabel}`}>
                <td>{variant.colorName}</td>
                <td>{variant.colorHex || "-"}</td>
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

async function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(file);
  });
}

async function inferSuggestedHexColor(dataUrl: string, colorName: string) {
  const imageHex = await dominantHexFromImage(dataUrl);
  const nameHex = suggestedHexFromColorName(colorName);

  if (imageHex && nameHex) {
    return mixHexColors(imageHex, nameHex, 0.28);
  }

  return imageHex || nameHex || "";
}

async function dominantHexFromImage(dataUrl: string) {
  if (typeof document === "undefined") return "";

  const image = await loadImage(dataUrl);
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return "";

  const width = Math.max(1, Math.min(48, image.naturalWidth || image.width || 48));
  const height = Math.max(1, Math.min(48, image.naturalHeight || image.height || 48));
  canvas.width = width;
  canvas.height = height;
  context.drawImage(image, 0, 0, width, height);

  const { data } = context.getImageData(0, 0, width, height);
  const dominant = weightedColorFromPixels(data, width, height);
  return dominant ? rgbToHex(dominant.r, dominant.g, dominant.b) : "";
}

function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Impossibile leggere l'immagine per stimare il colore."));
    image.src = src;
  });
}

function weightedColorFromPixels(data: Uint8ClampedArray, width: number, height: number) {
  let weightedRed = 0;
  let weightedGreen = 0;
  let weightedBlue = 0;
  let totalWeight = 0;
  let fallbackRed = 0;
  let fallbackGreen = 0;
  let fallbackBlue = 0;
  let fallbackWeight = 0;

  for (let index = 0; index < data.length; index += 4) {
    const red = data[index] ?? 0;
    const green = data[index + 1] ?? 0;
    const blue = data[index + 2] ?? 0;
    const alpha = data[index + 3] ?? 0;
    if (alpha < 32) continue;

    const pixelIndex = index / 4;
    const x = pixelIndex % width;
    const y = Math.floor(pixelIndex / width);
    const centerBias = centerWeight(x, y, width, height);
    const { saturation, lightness } = rgbToHsl(red, green, blue);
    const chromaWeight = saturation > 0.08 ? saturation * 1.4 + 0.2 : 0;
    const lightnessWeight = 1 - Math.min(Math.abs(lightness - 0.52), 0.52);
    const weight = centerBias * (chromaWeight + lightnessWeight * 0.35);

    fallbackRed += red * centerBias;
    fallbackGreen += green * centerBias;
    fallbackBlue += blue * centerBias;
    fallbackWeight += centerBias;

    if (weight <= 0.12) continue;

    weightedRed += red * weight;
    weightedGreen += green * weight;
    weightedBlue += blue * weight;
    totalWeight += weight;
  }

  if (totalWeight > 0) {
    return {
      r: Math.round(weightedRed / totalWeight),
      g: Math.round(weightedGreen / totalWeight),
      b: Math.round(weightedBlue / totalWeight),
    };
  }

  if (fallbackWeight > 0) {
    return {
      r: Math.round(fallbackRed / fallbackWeight),
      g: Math.round(fallbackGreen / fallbackWeight),
      b: Math.round(fallbackBlue / fallbackWeight),
    };
  }

  return null;
}

function centerWeight(x: number, y: number, width: number, height: number) {
  const normalizedX = width <= 1 ? 0 : x / (width - 1);
  const normalizedY = height <= 1 ? 0 : y / (height - 1);
  const distanceX = Math.abs(normalizedX - 0.5);
  const distanceY = Math.abs(normalizedY - 0.5);
  return Math.max(0.35, 1 - (distanceX + distanceY) * 0.85);
}

function rgbToHsl(red: number, green: number, blue: number) {
  const r = red / 255;
  const g = green / 255;
  const b = blue / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  const delta = max - min;

  if (delta === 0) {
    return { saturation: 0, lightness };
  }

  const saturation =
    lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);

  return { saturation, lightness };
}

function rgbToHex(red: number, green: number, blue: number) {
  const toHex = (value: number) => Math.max(0, Math.min(255, value)).toString(16).padStart(2, "0");
  return `#${toHex(red)}${toHex(green)}${toHex(blue)}`.toUpperCase();
}

function mixHexColors(primaryHex: string, secondaryHex: string, secondaryRatio = 0.3) {
  const primary = hexToRgb(primaryHex);
  const secondary = hexToRgb(secondaryHex);
  if (!primary) return normalizeHexColor(secondaryHex);
  if (!secondary) return normalizeHexColor(primaryHex);

  const ratio = Math.max(0, Math.min(1, secondaryRatio));
  return rgbToHex(
    Math.round(primary.r * (1 - ratio) + secondary.r * ratio),
    Math.round(primary.g * (1 - ratio) + secondary.g * ratio),
    Math.round(primary.b * (1 - ratio) + secondary.b * ratio),
  );
}

function hexToRgb(hex: string) {
  const normalized = normalizeHexColor(hex);
  if (!isValidHexColor(normalized)) return null;

  return {
    r: Number.parseInt(normalized.slice(1, 3), 16),
    g: Number.parseInt(normalized.slice(3, 5), 16),
    b: Number.parseInt(normalized.slice(5, 7), 16),
  };
}

async function postJson<T>(url: string, body: unknown, sessionToken?: string): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}),
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      text.trim() || `Richiesta fallita (${response.status}). Riprova o controlla i log Render.`,
    );
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    const text = await response.text();
    throw new Error(
      `Il server ha restituito una risposta non JSON (${response.status}). ${stripHtmlForMessage(text)}`,
    );
  }

  return response.json();
}

async function getShopifySessionToken(shopify: unknown) {
  if (
    typeof shopify === "object" &&
    shopify !== null &&
    "idToken" in shopify &&
    typeof shopify.idToken === "function"
  ) {
    return shopify.idToken();
  }

  return undefined;
}

function productCreatorApiUrl() {
  const url = new URL(window.location.href);
  url.pathname = "/app/product-creator-action";
  return `${url.pathname}${url.search}`;
}

function stripHtmlForMessage(text: string) {
  return text
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

async function postCreateProductWithDirectUploads(
  payload: ProductCreatorPayload,
  imageFiles: Map<string, File>,
  pdfFile: File | null,
  sessionToken?: string,
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

  const targets = await uploadFilesBestEffort(uploadItems, sessionToken);

  return postJson<ActionResponse>(productCreatorApiUrl(), {
    intent: "createProduct",
    payload: { ...payload, draftId: undefined },
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
  }, sessionToken);
}

async function uploadFilesBestEffort(uploadItems: ClientUploadItem[], sessionToken?: string) {
  if (!uploadItems.length) return [];

  try {
    const prepareResponse = await postJson<ActionResponse>(productCreatorApiUrl(), {
      intent: "prepareUploads",
      files: uploadItems.map((item) => ({
        key: item.key,
        fileName: item.fileName,
        mimeType: item.mimeType,
        resource: item.resource,
      })),
    }, sessionToken);

    const targets = prepareResponse.uploadTargets ?? [];
    if (targets.length !== uploadItems.length) return [];

    const uploadedTargets = await Promise.all(
      uploadItems.map(async (item) => {
        const target = targets.find((uploadTarget) => uploadTarget.key === item.key);
        if (!target) return null;

        const formData = new FormData();
        target.parameters.forEach((parameter) => {
          formData.append(parameter.name, parameter.value);
        });
        formData.append("file", item.file);

        const uploadResponse = await fetch(target.url, {
          method: "POST",
          body: formData,
        });

        return uploadResponse.ok ? target : null;
      }),
    );

    return uploadedTargets.filter((target): target is PreparedUploadTarget => Boolean(target));
  } catch {
    return [];
  }
}

function stripBinaryData(payload: ProductCreatorPayload): ProductCreatorPayload {
  return {
    ...payload,
    draftId: undefined,
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
  .image-row { display: grid; grid-template-columns: 84px minmax(150px, 1fr) minmax(150px, 1fr) minmax(170px, 1fr) 160px 140px auto; gap: 12px; align-items: end; padding: 12px; border: 1px solid #e1e5ea; border-radius: 8px; }
  .image-row img, .image-row > div:first-child { width: 84px; height: 84px; object-fit: cover; border-radius: 6px; background: #eef1f4; }
  .image-cover { align-self: center; padding-bottom: 9px; }
  .hex-field { display: grid; grid-template-columns: 20px minmax(0, 1fr) auto; gap: 8px; align-items: center; }
  .hex-swatch { width: 20px; height: 20px; border-radius: 6px; border: 1px solid #c9ced6; box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.25); }
  .hex-swatch--small { width: 18px; height: 18px; border-radius: 5px; }
  .color-groups { border: 1px solid #e1e5ea; border-radius: 8px; padding: 12px; display: grid; gap: 8px; }
  .color-groups h3 { margin: 0; font-size: 15px; }
  .color-group { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; color: #3f4750; }
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
