// C5-12: census data for every county the stops touch.
import { describe, expect, it, vi } from 'vitest';
import type { BlockGroupData } from '../../../services/demographics';
import { fetchServiceAreaBlockGroups, sampleStopCells } from '../serviceAreaCensus';

const bg = (geoid: string) => ({ geoid }) as BlockGroupData;
const stop = (lat: number, lon: number) => ({ stop_lat: lat, stop_lon: lon });

describe('fetchServiceAreaBlockGroups', () => {
  it('fetches every county once and concatenates block groups', async () => {
    const lookupFips = vi.fn(async (_lat: number, lon: number) =>
      lon < -111.5
        ? { stateFips: '30', countyFips: '031' }
        : { stateFips: '30', countyFips: '067' },
    );
    const fetchCensusData = vi.fn(async (_s: string, c: string) =>
      c === '031' ? [bg('300310001'), bg('dup')] : [bg('300670001'), bg('dup')],
    );
    const out = await fetchServiceAreaBlockGroups(
      [stop(45.7, -111.0), stop(45.7, -111.01), stop(45.7, -112.0)],
      { lookupFips, fetchCensusData },
    );
    expect(fetchCensusData).toHaveBeenCalledTimes(2);
    expect(out.map((b) => b.geoid).sort()).toEqual(['300310001', '300670001', 'dup']);
  });

  it('skips a failed cell but throws when nothing resolves', async () => {
    const fetchCensusData = vi.fn(async () => [bg('a')]);
    const out = await fetchServiceAreaBlockGroups([stop(1, 1), stop(5, 5)], {
      lookupFips: vi.fn()
        .mockRejectedValueOnce(new Error('water'))
        .mockResolvedValue({ stateFips: '01', countyFips: '001' }),
      fetchCensusData,
    });
    expect(out).toHaveLength(1);
    await expect(
      fetchServiceAreaBlockGroups([stop(1, 1)], {
        lookupFips: vi.fn().mockRejectedValue(new Error('down')),
        fetchCensusData,
      }),
    ).rejects.toThrow('down');
  });

  it('caps the number of sampled cells', () => {
    const stops = Array.from({ length: 100 }, (_, i) => stop(i, i));
    expect(sampleStopCells(stops, 40)).toHaveLength(40);
  });
});
