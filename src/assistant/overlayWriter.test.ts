import { expect, it } from 'vitest';
import { overlayMessages, readOverlayLines } from './overlayWriter';

it('asks for one line per moment with the brand, category and direction', () => {
  const [, user] = overlayMessages({ brand: 'softwings25', category: 'InspirationalBunny', title: 'Bunny at sunrise', prompt: 'a bunny watches the sun come up', direction: 'inspirational quotes', beats: [[0, 3], [3, 8]] });
  expect(user.content).toContain('InspirationalBunny');
  expect(user.content).toContain('inspirational quotes');
  expect(user.content).toContain('Write 2 lines');
  expect(user.content).toContain('3.0s to 8.0s');
});

it('reads the lines, defaults unknown animations and drops hashtags', () => {
  expect(readOverlayLines('```json\n{"lines":[{"text":"Small hops #bunny","animation":"pop"},{"text":"Big dreams","animation":"spin"}]}\n```', 2))
    .toEqual([{ text: 'Small hops', animation: 'pop' }, { text: 'Big dreams', animation: 'fade' }]);
});

it('refuses the wrong number of lines or empty text', () => {
  expect(readOverlayLines('{"lines":[{"text":"One"}]}', 2)).toBeNull();
  expect(readOverlayLines('{"lines":[{"text":""}]}', 1)).toBeNull();
  expect(readOverlayLines('no json', 1)).toBeNull();
});
