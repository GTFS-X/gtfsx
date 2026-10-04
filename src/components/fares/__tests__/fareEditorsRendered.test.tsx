// @vitest-environment jsdom
// Rendered Fares v2 editor tests.
//   S1-16  a refused delete (the entity is still referenced) keeps the editor
//          on the entity and shows the RemovalBlockedNotice, in all seven
//          editors. The store refusal and describeRemovalBlockers are pinned
//          elsewhere; these pin each editor's handling of `result.removed`.
//   C3-08  FareProductsEditor addresses a product's rows by index: editing or
//          deleting row 2 of a two-row product leaves row 1 alone.
import '../../../test-utils/dom';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ComponentType } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { resetStore, store } from '../../../test-utils/store';
import type { AppStore } from '../../../store';
import { AreasEditor } from '../AreasEditor';
import { NetworksEditor } from '../NetworksEditor';
import { RiderCategoriesEditor } from '../RiderCategoriesEditor';
import { FareMediaEditor } from '../FareMediaEditor';
import { FareProductsEditor } from '../FareProductsEditor';
import { FareLegRulesEditor } from '../FareLegRulesEditor';
import { TimeframesEditor } from '../TimeframesEditor';

const product = { fare_product_id: 'p1', fare_product_name: 'Single ride', amount: '2.00', currency: 'USD' };
const wk = {
  service_id: 'WK', monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1,
  saturday: 0, sunday: 0, start_date: '20260101', end_date: '20261231',
};

interface Case {
  name: string;
  Editor: ComponentType;
  seed: Partial<AppStore>;
  /** Text of the list row to open; null when rows are edited in place. */
  openRow: string | null;
  /** title of the delete control. */
  deleteTitle: string;
  /** Whether the delete control asks for a second "Delete" click. */
  confirm: boolean;
  stillThere: (s: AppStore) => boolean;
}

const cases: Case[] = [
  {
    name: 'AreasEditor: area used by a leg rule',
    Editor: AreasEditor,
    seed: {
      fareAreas: [{ area_id: 'A1', area_name: 'Downtown' }],
      fareProducts: [product],
      fareLegRules: [{ leg_group_id: 'g1', from_area_id: 'A1', fare_product_id: 'p1' }],
    },
    openRow: 'Downtown', deleteTitle: 'Delete this area', confirm: true,
    stillThere: (s) => s.fareAreas.some((a) => a.area_id === 'A1'),
  },
  {
    name: 'NetworksEditor: network used by a leg rule',
    Editor: NetworksEditor,
    seed: {
      fareNetworks: [{ network_id: 'N1', network_name: 'Metro' }],
      fareProducts: [product],
      fareLegRules: [{ leg_group_id: 'g1', network_id: 'N1', fare_product_id: 'p1' }],
    },
    openRow: 'Metro', deleteTitle: 'Delete this network', confirm: true,
    stillThere: (s) => s.fareNetworks.some((n) => n.network_id === 'N1'),
  },
  {
    name: 'RiderCategoriesEditor: category priced by a product',
    Editor: RiderCategoriesEditor,
    seed: {
      riderCategories: [{ rider_category_id: 'snr', rider_category_name: 'Senior' }],
      fareProducts: [{ ...product, rider_category_id: 'snr' }],
    },
    openRow: 'Senior', deleteTitle: 'Delete this rider category', confirm: true,
    stillThere: (s) => s.riderCategories.some((c) => c.rider_category_id === 'snr'),
  },
  {
    name: 'FareMediaEditor: medium used by a product',
    Editor: FareMediaEditor,
    seed: {
      fareMedia: [{ fare_media_id: 'card', fare_media_name: 'Smart card', fare_media_type: 2 }],
      fareProducts: [{ ...product, fare_media_id: 'card' }],
    },
    openRow: 'Smart card', deleteTitle: 'Delete this fare medium', confirm: true,
    stillThere: (s) => s.fareMedia.some((m) => m.fare_media_id === 'card'),
  },
  {
    name: 'FareProductsEditor: product used by a transfer rule',
    Editor: FareProductsEditor,
    seed: {
      fareProducts: [product],
      fareTransferRules: [{ from_leg_group_id: 'g1', to_leg_group_id: 'g1', fare_transfer_type: 0, fare_product_id: 'p1' }],
    },
    openRow: 'Single ride', deleteTitle: 'Delete this fare product', confirm: true,
    stillThere: (s) => s.fareProducts.some((p) => p.fare_product_id === 'p1'),
  },
  {
    name: "FareLegRulesEditor: a leg group's last rule used by a transfer rule",
    Editor: FareLegRulesEditor,
    seed: {
      fareProducts: [product],
      fareLegRules: [{ leg_group_id: 'g1', fare_product_id: 'p1' }],
      fareTransferRules: [{ from_leg_group_id: 'g1', to_leg_group_id: 'g1', fare_transfer_type: 0 }],
    },
    openRow: 'Single ride', deleteTitle: 'Delete this leg rule', confirm: true,
    stillThere: (s) => s.fareLegRules.length === 1,
  },
  {
    name: "TimeframesEditor: a group's last window used by a leg rule",
    Editor: TimeframesEditor,
    seed: {
      calendars: [wk],
      timeframes: [{ timeframe_group_id: 'peak', start_time: '07:00:00', end_time: '09:00:00', service_id: 'WK' }],
      fareProducts: [product],
      fareLegRules: [{ leg_group_id: 'g1', from_timeframe_group_id: 'peak', fare_product_id: 'p1' }],
    },
    openRow: null, deleteTitle: 'Remove this window', confirm: false,
    stillThere: (s) => s.timeframes.length === 1,
  },
];

describe('refused Fares v2 deletes keep the entity open and say why (S1-16)', () => {
  it.each(cases)('$name', async ({ Editor, seed, openRow, deleteTitle, confirm, stillThere }) => {
    resetStore(seed);
    const user = userEvent.setup();
    render(<Editor />);
    if (openRow) await user.click(screen.getAllByText(openRow)[0].closest('button')!);
    await user.click(screen.getByTitle(deleteTitle));
    if (confirm) await user.click(screen.getByRole('button', { name: 'Delete' }));

    expect(stillThere(store())).toBe(true);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/^Can't delete .*used by/);
    // Still on the entity: its delete control is still rendered.
    expect(screen.getByTitle(deleteTitle)).toBeInTheDocument();
  });
});

describe('FareProductsEditor addresses rows by index (C3-08)', () => {
  beforeEach(() => {
    resetStore({
      riderCategories: [
        { rider_category_id: 'adult', rider_category_name: 'Adult' },
        { rider_category_id: 'snr', rider_category_name: 'Senior' },
      ],
      fareProducts: [
        { ...product, amount: '2.00', rider_category_id: 'adult' },
        { ...product, amount: '1.00', rider_category_id: 'snr' },
      ],
    });
  });

  const openSeniorRow = async (user: ReturnType<typeof userEvent.setup>) => {
    const row = screen.getAllByRole('button').find((b) => /^Senior/.test(b.textContent ?? ''))!;
    await user.click(row);
  };

  it("editing row 2's price leaves row 1 unchanged", async () => {
    const user = userEvent.setup();
    render(<FareProductsEditor />);
    await openSeniorRow(user);
    const amount = screen.getByPlaceholderText('2.50');
    expect(amount).toHaveValue('1.00');
    await user.clear(amount);
    await user.type(amount, '0.75');

    expect(store().fareProducts.map((p) => [p.rider_category_id, p.amount])).toEqual([
      ['adult', '2.00'],
      ['snr', '0.75'],
    ]);
  });

  it('deleting row 2 removes only that row', async () => {
    const user = userEvent.setup();
    render(<FareProductsEditor />);
    await openSeniorRow(user);
    await user.click(screen.getByTitle('Delete this price row'));
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    expect(store().fareProducts.map((p) => [p.rider_category_id, p.amount])).toEqual([['adult', '2.00']]);
  });
});
