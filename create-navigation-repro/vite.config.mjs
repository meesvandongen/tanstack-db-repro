import { fakeElectricPlugin } from '../fake-electric/fake-electric.mjs';
import { originalMockPlugin } from './original-mock.mjs';

export default {
  plugins: [
    process.env.MOCK === 'original'
      ? originalMockPlugin()
      : fakeElectricPlugin({ shapePath: '/shape' }),
  ],
  server: {
    host: '127.0.0.1',
    port: Number(process.env.REPRO_PORT ?? 4313),
    strictPort: true,
  },
};
