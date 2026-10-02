// Regression: the timetable's 2-pattern Direction toggle showed two identical
// buttons ("Outbound | Outbound") when both shapes share a direction (a branch
// or variant), and Segmented keyed its buttons by label, so React warned about
// duplicate keys. twoPatternLabels names same-direction shapes by shape, and
// Segmented keys by index.
import { describe, it, expect } from 'vitest';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { twoPatternLabels, namedShapeLabel, type ShapePattern } from '../shapePatterns';
import { Segmented } from '../Segmented';
import type { Route, Shape } from '../../../types/gtfs';

const route = {
  route_id: 'r', route_type: 3,
  _direction_0_name: 'Northbound', _direction_1_name: 'Southbound',
} as unknown as Route;
const shape = (id: string, name?: string): Shape => ({ shape_id: id, points: [], _name: name });

describe('twoPatternLabels', () => {
  it('uses direction names when the two shapes are in different directions', () => {
    const p: ShapePattern[] = [{ shapeId: 'a', directionId: 0 }, { shapeId: 'b', directionId: 1 }];
    expect(twoPatternLabels(p, route, [shape('a', 'Main'), shape('b', 'Main back')]))
      .toEqual(['Northbound', 'Southbound']);
  });

  it('names same-direction shapes by shape, so the two buttons differ', () => {
    const p: ShapePattern[] = [{ shapeId: 'a', directionId: 0 }, { shapeId: 'b', directionId: 0 }];
    const labels = twoPatternLabels(p, route, [shape('a', 'Main line'), shape('b', 'Airport branch')]);
    expect(labels).toEqual(['Main line · Northbound', 'Airport branch · Northbound']);
    expect(new Set(labels).size).toBe(2);
  });

  it('falls back to the shape_id for unnamed same-direction shapes', () => {
    const p: ShapePattern[] = [{ shapeId: 'a', directionId: 1 }, { shapeId: 'b', directionId: 1 }];
    expect(twoPatternLabels(p, route, [shape('a'), shape('b', '  ')]))
      .toEqual(['Southbound · a', 'Southbound · b']);
  });

  it('falls back to Outbound/Inbound with no route direction names', () => {
    const p: ShapePattern[] = [{ shapeId: 'a', directionId: 0 }, { shapeId: 'b', directionId: 0 }];
    expect(twoPatternLabels(p, null, [shape('a', 'Local'), shape('b', 'Express')]))
      .toEqual(['Local · Outbound', 'Express · Outbound']);
  });
});

describe('namedShapeLabel', () => {
  it('does not repeat a name that already is the direction name', () => {
    expect(namedShapeLabel('northbound', route, 0)).toBe('northbound');
    expect(namedShapeLabel('Express', route, 1)).toBe('Express · Southbound');
  });
});

describe('Segmented keys', () => {
  it('gives each button a unique key even when labels repeat', () => {
    // Call the component directly and read the keys of the children it
    // returns (server rendering does not surface React's duplicate-key warning).
    const el = Segmented({ value: 0, onChange: () => {}, options: ['Outbound', 'Outbound'] }) as ReactElement<{ children: ReactElement[] }>;
    const keys = el.props.children.map((c) => c.key);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
    // And it still renders both buttons.
    const html = renderToStaticMarkup(
      createElement(Segmented, { value: 0, onChange: () => {}, options: ['Outbound', 'Outbound'] }),
    );
    expect(html.match(/role="tab"/g)?.length).toBe(2);
  });
});
