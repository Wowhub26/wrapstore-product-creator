/** @jsxImportSource preact */
import "@shopify/ui-extensions/preact";

import {
  useApplyCartLinesChange,
  useCartLines,
  useInstructions,
} from "@shopify/ui-extensions/checkout/preact";
import type {
  CartLine,
  CartLineAddChange,
} from "@shopify/ui-extensions/checkout";
import { render } from "preact";
import { useMemo, useState } from "preact/hooks";

type PersonalizationMode = "custom" | "copy";

type PrintPositionVariant = {
  id: string;
  label: string;
  priceLabel: string;
};

type ColorOption = {
  id: string;
  label: string;
};

type SizeOption = {
  id: string;
  label: string;
};

type CheckoutOffer = {
  productTitle: string;
  subtitle: string;
  printPositions: PrintPositionVariant[];
  colors: ColorOption[];
  sizes: SizeOption[];
};

type QuantityBySize = Record<string, number>;

type CartLineChoice = {
  id: string;
  label: string;
};

type Notice = {
  tone: "success" | "critical" | "warning";
  message: string;
};

type ValueTarget = EventTarget & {
  value?: string;
};

const CUSTOM_MODE_ATTRIBUTE_VALUE = "Personalizzata al checkout";
const COPY_MODE_ATTRIBUTE_KEY =
  "Copia la personalizzazione degli altri prodotti";

// TODO: Replace this mock with Storefront API product metafields/metaobjects.
const MOCK_OFFER: CheckoutOffer = {
  productTitle: "T-shirt personalizzata",
  subtitle: "Aggiungi una stampa coordinata al tuo ordine",
  printPositions: [
    {
      id: "gid://shopify/ProductVariant/000000000001",
      label: "Fronte",
      priceLabel: "+ EUR 9,90",
    },
    {
      id: "gid://shopify/ProductVariant/000000000002",
      label: "Retro",
      priceLabel: "+ EUR 11,90",
    },
  ],
  colors: [
    { id: "nero", label: "Nero" },
    { id: "bianco", label: "Bianco" },
    { id: "rosso", label: "Rosso" },
  ],
  sizes: [
    { id: "s", label: "S" },
    { id: "m", label: "M" },
    { id: "l", label: "L" },
    { id: "xl", label: "XL" },
    { id: "xxl", label: "XXL" },
  ],
};

export default function checkoutCrossSell() {
  render(<CheckoutCrossSell />, document.body);
}

function CheckoutCrossSell() {
  const applyCartLinesChange = useApplyCartLinesChange();
  const cartLines = useCartLines();
  const instructions = useInstructions();
  const [mode, setMode] = useState<PersonalizationMode>("custom");
  const [selectedPrintPositionId, setSelectedPrintPositionId] = useState(
    MOCK_OFFER.printPositions[0]?.id ?? "",
  );
  const [selectedColorId, setSelectedColorId] = useState(
    MOCK_OFFER.colors[0]?.id ?? "",
  );
  const [selectedCopyLineId, setSelectedCopyLineId] = useState("");
  const [quantities, setQuantities] = useState<QuantityBySize>(() =>
    buildInitialQuantities(MOCK_OFFER.sizes),
  );
  const [isAdding, setIsAdding] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  const selectedPrintPosition =
    MOCK_OFFER.printPositions.find(
      (position) => position.id === selectedPrintPositionId,
    ) ?? MOCK_OFFER.printPositions[0];
  const selectedColor =
    MOCK_OFFER.colors.find((color) => color.id === selectedColorId) ??
    MOCK_OFFER.colors[0];
  const selectedSizes = useMemo(
    () => getSelectedSizes(MOCK_OFFER.sizes, quantities),
    [quantities],
  );
  const cartLineChoices = useMemo(
    () => buildCartLineChoices(cartLines),
    [cartLines],
  );
  const selectedCopyLine =
    cartLineChoices.find((line) => line.id === selectedCopyLineId) ??
    cartLineChoices[0];
  const canAddCartLine =
    instructions.lines.canAddCartLine && Boolean(selectedPrintPosition);
  const canSubmit =
    mode === "custom"
      ? selectedSizes.length > 0
      : Boolean(selectedCopyLine);

  async function handleAdd() {
    if (!selectedPrintPosition) return;

    if (!canAddCartLine) {
      setNotice({
        tone: "warning",
        message: "Questo checkout non consente ancora di aggiungere prodotti.",
      });
      return;
    }

    if (!canSubmit) {
      setNotice({
        tone: "warning",
        message: "Seleziona almeno una taglia o una riga da copiare.",
      });
      return;
    }

    const changes =
      mode === "custom" && selectedColor
        ? buildCustomPersonalizationChanges({
            color: selectedColor,
            printPosition: selectedPrintPosition,
            selectedSizes,
          })
        : selectedCopyLine
          ? buildCopyPersonalizationChanges({
              printPosition: selectedPrintPosition,
              selectedCopyLine,
            })
          : [];

    setIsAdding(true);
    setNotice(null);

    for (const change of changes) {
      const result = await applyCartLinesChange(change);

      if (result.type === "error") {
        console.error(result.message);
        setIsAdding(false);
        setNotice({
          tone: "critical",
          message: "Impossibile aggiungere il prodotto al checkout.",
        });
        return;
      }
    }

    setIsAdding(false);
    setNotice({
      tone: "success",
      message: "Prodotto aggiunto al checkout.",
    });
  }

  return (
    <s-section>
      <s-stack>
        <s-stack>
          <s-heading>{MOCK_OFFER.productTitle}</s-heading>
          <s-text>{MOCK_OFFER.subtitle}</s-text>
        </s-stack>

        <s-select
          label="Tipo personalizzazione"
          value={mode}
          onChange={(event) =>
            setMode(readSelectValue(event) as PersonalizationMode)
          }
        >
          <s-option value="custom">{CUSTOM_MODE_ATTRIBUTE_VALUE}</s-option>
          <s-option value="copy">
            Copia la personalizzazione degli altri prodotti
          </s-option>
        </s-select>

        <s-select
          label="Posizione Stampa"
          value={selectedPrintPositionId}
          onChange={(event) => setSelectedPrintPositionId(readSelectValue(event))}
        >
          {MOCK_OFFER.printPositions.map((position) => (
            <s-option key={position.id} value={position.id}>
              {position.label} {position.priceLabel}
            </s-option>
          ))}
        </s-select>

        {mode === "custom" ? (
          <s-stack>
            <s-select
              label="Colore"
              value={selectedColorId}
              onChange={(event) => setSelectedColorId(readSelectValue(event))}
            >
              {MOCK_OFFER.colors.map((color) => (
                <s-option key={color.id} value={color.id}>
                  {color.label}
                </s-option>
              ))}
            </s-select>

            <s-stack>
              <s-text>Taglie</s-text>
              {MOCK_OFFER.sizes.map((size) => {
                const quantity = quantities[size.id] ?? 0;

                return (
                  <s-stack key={size.id} direction="inline">
                    <s-text>{size.label}</s-text>
                    <s-button
                      disabled={quantity === 0}
                      onClick={() => updateQuantity(size.id, quantity - 1)}
                    >
                      -
                    </s-button>
                    <s-text>{quantity}</s-text>
                    <s-button onClick={() => updateQuantity(size.id, quantity + 1)}>
                      +
                    </s-button>
                  </s-stack>
                );
              })}
            </s-stack>
          </s-stack>
        ) : (
          <s-select
            label="Prodotto da copiare"
            value={selectedCopyLine?.id ?? ""}
            onChange={(event) => setSelectedCopyLineId(readSelectValue(event))}
          >
            {cartLineChoices.length ? (
              cartLineChoices.map((line) => (
                <s-option key={line.id} value={line.id}>
                  {line.label}
                </s-option>
              ))
            ) : (
              <s-option value="">Nessun prodotto disponibile</s-option>
            )}
          </s-select>
        )}

        {notice ? <s-text>{notice.message}</s-text> : null}

        <s-button
          disabled={!canSubmit || isAdding}
          onClick={() => {
            void handleAdd();
          }}
        >
          {isAdding ? "Aggiungo..." : "Aggiungi"}
        </s-button>
      </s-stack>
    </s-section>
  );

  function updateQuantity(sizeId: string, nextQuantity: number) {
    setQuantities((current) => ({
      ...current,
      [sizeId]: Math.max(0, nextQuantity),
    }));
  }
}

function buildInitialQuantities(sizes: SizeOption[]): QuantityBySize {
  return Object.fromEntries(sizes.map((size) => [size.id, 0]));
}

function getSelectedSizes(sizes: SizeOption[], quantities: QuantityBySize) {
  return sizes
    .map((size) => ({
      ...size,
      quantity: quantities[size.id] ?? 0,
    }))
    .filter((size) => size.quantity > 0);
}

function buildCustomPersonalizationChanges({
  color,
  printPosition,
  selectedSizes,
}: {
  color: ColorOption;
  printPosition: PrintPositionVariant;
  selectedSizes: Array<SizeOption & { quantity: number }>;
}): CartLineAddChange[] {
  return selectedSizes.map((size) => ({
    type: "addCartLine",
    merchandiseId: printPosition.id,
    quantity: size.quantity,
    attributes: [
      { key: "Colore", value: color.label },
      { key: "Taglia", value: size.label },
      {
        key: "Tipo personalizzazione",
        value: CUSTOM_MODE_ATTRIBUTE_VALUE,
      },
    ],
  }));
}

function buildCopyPersonalizationChanges({
  printPosition,
  selectedCopyLine,
}: {
  printPosition: PrintPositionVariant;
  selectedCopyLine: CartLineChoice;
}): CartLineAddChange[] {
  return [
    {
      type: "addCartLine",
      merchandiseId: printPosition.id,
      quantity: 1,
      attributes: [
        {
          key: COPY_MODE_ATTRIBUTE_KEY,
          value: selectedCopyLine.label,
        },
      ],
    },
  ];
}

function buildCartLineChoices(lines: CartLine[]): CartLineChoice[] {
  return lines.map((line, index) => {
    const merchandise = line.merchandise as {
      title?: string;
      product?: { title?: string };
    };
    const productTitle =
      merchandise.product?.title || merchandise.title || `Prodotto ${index + 1}`;
    const size = line.attributes.find((attribute) => attribute.key === "Taglia");
    const color = line.attributes.find((attribute) => attribute.key === "Colore");
    const details = [color?.value, size?.value].filter(Boolean).join(" / ");

    return {
      id: line.id,
      label: details ? `${productTitle} - ${details}` : productTitle,
    };
  });
}

function readSelectValue(event: Event) {
  return String((event.currentTarget as ValueTarget).value ?? "");
}
