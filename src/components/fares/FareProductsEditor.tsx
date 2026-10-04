import { useState } from 'react';
import { useStore } from '../../store';
import { FormField } from '../ui/FormField';
import { Breadcrumb } from '../ui/Breadcrumb';
import { RailSubHeading } from '../ui/RailHeadings';
import { EditActions } from '../ui/EditActions';
import { generateId } from '../../services/idGenerator';
import type { FareProduct } from '../../types/gtfs';
import { describeRemovalBlockers, groupProductRows, productRowCollides } from './fareEditorHelpers';
import { RemovalBlockedNotice } from './RemovalBlockedNotice';

/**
 * GTFS-Fares v2 Fare Products editor (fare_products.txt). A fare product is the
 * purchasable thing (single ride, day pass, …) with a price. It optionally
 * references a rider_category and a fare_media (foreign keys, picked from
 * dropdowns). fare_product_id, amount, and currency are required.
 *
 * The file's primary key is (fare_product_id, rider_category_id,
 * fare_media_id): one product id can have a row per rider category / medium
 * (adult $2.50, senior $1.25). Rows are therefore addressed by index, the list
 * groups them by product id, and an id rename moves every row of the product
 * (C3-08).
 */
export function FareProductsEditor() {
  const fareProducts = useStore((s) => s.fareProducts);
  const riderCategories = useStore((s) => s.riderCategories);
  const fareMedia = useStore((s) => s.fareMedia);
  const addFareProduct = useStore((s) => s.addFareProduct);
  const updateFareProductAt = useStore((s) => s.updateFareProductAt);
  const renameFareProductId = useStore((s) => s.renameFareProductId);
  const removeFareProductAt = useStore((s) => s.removeFareProductAt);

  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [idDraft, setIdDraft] = useState('');
  const [idError, setIdError] = useState<string | undefined>();
  // Why the last delete / scope change was refused; cleared when the selection changes.
  const [blocked, setBlocked] = useState<string | null>(null);

  const selected = selectedIndex != null ? fareProducts[selectedIndex] ?? null : null;
  const siblingRows = selected
    ? fareProducts.filter((p) => p.fare_product_id === selected.fare_product_id).length
    : 0;

  const riderName = (id?: string) =>
    riderCategories.find((c) => c.rider_category_id === id)?.rider_category_name || id;
  const mediaName = (id?: string) =>
    fareMedia.find((m) => m.fare_media_id === id)?.fare_media_name || id;

  const open = (index: number | null) => {
    setSelectedIndex(index);
    setBlocked(null);
    const p = index != null ? fareProducts[index] : undefined;
    setIdDraft(p?.fare_product_id ?? '');
    setIdError(undefined);
  };

  const handleAdd = () => {
    const product: FareProduct = {
      fare_product_id: generateId('product'),
      amount: '',
      currency: 'USD',
    };
    addFareProduct(product);
    // The new row is appended at the end.
    setSelectedIndex(fareProducts.length);
    setBlocked(null);
    setIdDraft(product.fare_product_id);
    setIdError(undefined);
  };

  const update = (index: number, updates: Partial<Omit<FareProduct, 'fare_product_id'>>) => {
    if (productRowCollides(fareProducts, index, updates)) {
      setBlocked('Another row of this product already has that rider category and fare medium.');
      return;
    }
    setBlocked(null);
    updateFareProductAt(index, updates);
  };

  const commitId = () => {
    if (!selected) return;
    const next = idDraft.trim();
    if (!next) {
      setIdError('Fare product ID is required.');
      setIdDraft(selected.fare_product_id);
      return;
    }
    if (next === selected.fare_product_id) { setIdError(undefined); return; }
    if (fareProducts.some((p) => p.fare_product_id === next)) {
      setIdError(`Fare product ID "${next}" is already in use.`);
      return;
    }
    // Renames every row of the product (and the leg/transfer rules priced
    // with it); the selected row keeps its index.
    renameFareProductId(selected.fare_product_id, next);
    setIdError(undefined);
  };

  // ── List view ─────────────────────────────────────────────────────────────
  if (!selected || selectedIndex == null) {
    const groups = groupProductRows(fareProducts);
    return (
      <div>
        <div className="mb-4 p-3 rounded-lg bg-gold-light border-2 border-amber-200">
          <p className="text-amber-700 text-sm">
            <strong>Fare products</strong> are the priced things a rider buys (single ride, day
            pass). Each has an amount and currency, and can be scoped to a rider category and fare
            medium. Leg and transfer rules point at products.
          </p>
        </div>

        <RailSubHeading count={groups.length}>Fare Products</RailSubHeading>

        <div className="space-y-1.5 mb-3">
          {groups.map((g) => {
            const first = g.rows[0].product;
            if (g.rows.length === 1) {
              const { product: p, index } = g.rows[0];
              return (
                <button
                  key={index}
                  onClick={() => open(index)}
                  className="w-full text-left px-3 py-2.5 rounded-lg text-sm bg-cream text-dark-brown hover:bg-sand transition-colors"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium truncate">
                      {p.fare_product_name || p.fare_product_id}
                    </span>
                    <span className="text-[11px] text-warm-gray shrink-0 font-mono">
                      {p.amount !== '' ? `${p.amount} ${p.currency}` : '— ' + p.currency}
                    </span>
                  </div>
                  <div className="text-[11px] text-warm-gray mt-0.5 truncate">
                    {[riderName(p.rider_category_id), mediaName(p.fare_media_id)].filter(Boolean).join(' · ') || p.fare_product_id}
                  </div>
                </button>
              );
            }
            return (
              <div key={g.id} className="rounded-lg bg-cream px-3 py-2">
                <div className="flex items-center justify-between gap-2 mb-1">
                  <span className="font-medium text-sm text-dark-brown truncate">
                    {first.fare_product_name || first.fare_product_id}
                  </span>
                  <span className="text-[11px] text-warm-gray shrink-0">{g.rows.length} prices</span>
                </div>
                <div className="space-y-1">
                  {g.rows.map(({ product: p, index }) => (
                    <button
                      key={index}
                      onClick={() => open(index)}
                      className="w-full text-left px-2 py-1.5 rounded-md text-[12px] bg-white/70 text-dark-brown hover:bg-sand transition-colors flex items-center justify-between gap-2"
                    >
                      <span className="truncate">
                        {[riderName(p.rider_category_id), mediaName(p.fare_media_id)].filter(Boolean).join(' · ') || 'Any rider · any medium'}
                      </span>
                      <span className="text-[11px] text-warm-gray shrink-0 font-mono">
                        {p.amount !== '' ? `${p.amount} ${p.currency}` : '— ' + p.currency}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>

        <button
          onClick={handleAdd}
          className="w-full py-2 rounded-lg border-2 border-dashed border-sand text-warm-gray text-sm font-medium hover:border-coral hover:text-coral transition-colors"
        >
          + Add fare product
        </button>
      </div>
    );
  }

  const idx = selectedIndex;
  const rowScope = [riderName(selected.rider_category_id), mediaName(selected.fare_media_id)]
    .filter(Boolean).join(' · ');

  // ── Detail view ───────────────────────────────────────────────────────────
  return (
    <div>
      <nav className="text-[13px] text-warm-gray mb-1">
        <Breadcrumb
          items={[
            { label: 'Fare Products', onClick: () => open(null) },
            { label: selected.fare_product_name || selected.fare_product_id, className: 'truncate' },
          ]}
        />
      </nav>

      <div className="flex items-center justify-between gap-3 mb-4">
        <h2 className="font-heading font-extrabold text-lg text-dark-brown leading-tight truncate flex-1 min-w-0">
          {selected.fare_product_name || selected.fare_product_id}
          {siblingRows > 1 && rowScope && (
            <span className="block text-[12px] font-body font-normal text-warm-gray truncate">{rowScope}</span>
          )}
        </h2>
        <EditActions
          onDelete={() => {
            const result = removeFareProductAt(idx);
            if (result.removed) open(null);
            else setBlocked(describeRemovalBlockers('this fare product', result, useStore.getState()));
          }}
          deleteTitle={siblingRows > 1 ? 'Delete this price row' : 'Delete this fare product'}
        />
      </div>
      <RemovalBlockedNotice message={blocked} onDismiss={() => setBlocked(null)} />

      <FormField
        label="Fare Product ID"
        value={idDraft}
        onChange={(v) => { setIdDraft(v); if (idError) setIdError(undefined); }}
        placeholder="fare_product_id"
        required
        error={idError}
      />
      {idDraft.trim() !== selected.fare_product_id && (
        <button
          onClick={commitId}
          className="mb-4 px-3 py-1.5 rounded-lg bg-coral text-white text-xs font-bold hover:bg-[#d4603a] transition-colors"
        >
          Rename to “{idDraft.trim() || '…'}”{siblingRows > 1 ? ` (all ${siblingRows} rows)` : ''}
        </button>
      )}

      <FormField
        label="Fare Product Name"
        value={selected.fare_product_name ?? ''}
        onChange={(v) => update(idx, { fare_product_name: v || undefined })}
        placeholder="e.g. Single Ride (optional)"
      />

      <div className="grid grid-cols-2 gap-2">
        <FormField
          label="Amount"
          value={selected.amount}
          onChange={(v) => update(idx, { amount: v })}
          placeholder="2.50"
          required
        />
        <FormField
          label="Currency"
          value={selected.currency}
          onChange={(v) => update(idx, { currency: v.toUpperCase() })}
          placeholder="USD"
          required
        />
      </div>

      <div className="mb-3">
        <label className="block text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-1">
          Rider Category
        </label>
        <select
          value={selected.rider_category_id ?? ''}
          onChange={(e) => update(idx, { rider_category_id: e.target.value || undefined })}
          className="w-full px-3 py-2 border-2 border-sand rounded-lg text-sm bg-cream focus:outline-none focus:border-coral focus:bg-white"
        >
          <option value="">Any rider (none)</option>
          {selected.rider_category_id && !riderCategories.some((c) => c.rider_category_id === selected.rider_category_id) && (
            <option value={selected.rider_category_id}>{selected.rider_category_id} (missing)</option>
          )}
          {riderCategories.map((c) => (
            <option key={c.rider_category_id} value={c.rider_category_id}>
              {c.rider_category_name || c.rider_category_id}
            </option>
          ))}
        </select>
      </div>

      <div className="mb-3">
        <label className="block text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-1">
          Fare Media
        </label>
        <select
          value={selected.fare_media_id ?? ''}
          onChange={(e) => update(idx, { fare_media_id: e.target.value || undefined })}
          className="w-full px-3 py-2 border-2 border-sand rounded-lg text-sm bg-cream focus:outline-none focus:border-coral focus:bg-white"
        >
          <option value="">Any medium (none)</option>
          {selected.fare_media_id && !fareMedia.some((m) => m.fare_media_id === selected.fare_media_id) && (
            <option value={selected.fare_media_id}>{selected.fare_media_id} (missing)</option>
          )}
          {fareMedia.map((m) => (
            <option key={m.fare_media_id} value={m.fare_media_id}>
              {m.fare_media_name || m.fare_media_id}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
