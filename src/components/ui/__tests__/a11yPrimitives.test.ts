// C5-14 (FormField label association), C5-21 (DayToggle/Segmented attributes).
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DayToggle } from '../DayToggle';
import { FormField } from '../FormField';
import { Segmented } from '../Segmented';

describe('FormField', () => {
  it('associates the label with the built-in input and describes errors', () => {
    const html = renderToStaticMarkup(createElement(FormField, { label: 'Name', value: '', error: 'Too short', required: true }));
    const labelFor = /<label[^>]*for="([^"]+)"/.exec(html)?.[1];
    const inputId = /<input[^>]*\sid="([^"]+)"/.exec(html)?.[1];
    expect(labelFor).toBeTruthy();
    expect(labelFor).toBe(inputId);
    const describedBy = /aria-describedby="([^"]+)"/.exec(html)?.[1];
    expect(html).toContain(`id="${describedBy}"`);
    expect(html).toContain('data-testid="field-name"');
  });
  it('injects the id into a single child control', () => {
    const html = renderToStaticMarkup(
      createElement(FormField, { label: 'Role' }, createElement('select', null, createElement('option', null, 'a'))),
    );
    const labelFor = /<label[^>]*for="([^"]+)"/.exec(html)?.[1];
    expect(html).toContain(`<select id="${labelFor}"`);
  });
});

describe('DayToggle / Segmented', () => {
  it('DayToggle buttons expose name and pressed state', () => {
    const html = renderToStaticMarkup(createElement(DayToggle, { values: { monday: 1 }, onChange: () => {} }));
    expect(html).toMatch(/aria-pressed="true"[^>]*aria-label="Monday"|aria-label="Monday"[^>]*aria-pressed="true"/);
    expect(html).toContain('aria-label="Tuesday"');
  });
  it('Segmented is a radio group', () => {
    const html = renderToStaticMarkup(createElement(Segmented, { value: 0, onChange: () => {}, options: ['Northbound', 'Southbound'] }));
    expect(html).toContain('role="radiogroup"');
    expect(html).toMatch(/role="radio"[^>]*aria-checked="true"/);
  });
});
