import { deriveFormPostcondition } from './src/journey/postcondition.js';

const page = 'https://shop.test/checkout';
const cases = ['https://user:pw@shop.test/thank-you', '/thank-you', 'https://shop.test/thank-you'];
for (const action of cases) {
  const g = deriveFormPostcondition(
    {
      selector: 'form#f', action, method: 'get', name: null, id: 'f', visible: true,
      fields: [], submitButtons: [], externalSubmitButtons: [],
    },
    'f',
    page,
  );
  console.log(`${action}\n  -> ${g.kind === 'generated' ? JSON.stringify(g.postcondition) : 'DECLINED: ' + g.reason}`);
}
