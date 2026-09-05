jest.mock('./find', () =>
	jest.fn().mockResolvedValue({ id: 1, name: 'Test song' })
);
jest.mock('../request', () => jest.fn());
jest.mock('../logger', () => ({
	logScope: () => ({ debug: jest.fn(), info: jest.fn(), error: jest.fn() }),
}));
jest.mock('../consts', () => ({
	PROVIDERS: {
		low: { check: jest.fn() },
		high: { check: jest.fn() },
		failed: { check: jest.fn() },
	},
	DEFAULT_SOURCE: ['low', 'high', 'failed'],
}));

const request = require('../request');
const { PROVIDERS } = require('../consts');
const match = require('./match');
const flac = require('../testdata/flac');

describe('highest-quality source selection', () => {
	const originalSetting = process.env.SELECT_MAX_BR;
	beforeEach(() => {
		process.env.SELECT_MAX_BR = 'true';
		PROVIDERS.low.check.mockResolvedValue('http://audio.test/low');
		PROVIDERS.high.check.mockResolvedValue('http://audio.test/high');
		PROVIDERS.failed.check.mockRejectedValue(
			new Error('Source unavailable')
		);
		request.mockImplementation(async (method, url) => ({
			statusCode: 206,
			url: new URL(url),
			headers: {
				'content-length': '8192',
				'content-range': 'bytes 0-8191/5000000',
			},
			body: async () =>
				flac({
					sampleRate: url.endsWith('/high') ? 96000 : 44100,
					bitDepth: url.endsWith('/high') ? 24 : 16,
				}),
		}));
	});
	afterEach(() => {
		if (originalSetting === undefined) delete process.env.SELECT_MAX_BR;
		else process.env.SELECT_MAX_BR = originalSetting;
		jest.clearAllMocks();
	});

	test('returns true format and bitrate for the higher-specification source', async () => {
		const result = await match(1);
		expect(result).toMatchObject({
			source: 'high',
			format: 'flac',
			lossless: true,
			bitDepth: 24,
			sampleRate: 96000,
		});
		expect(result.br).toBe(Math.round((5000000 * 8) / (441000 / 96000)));
		expect(result.br).not.toBe(999000);
	});

	test('still falls back when the higher-quality source fails', async () => {
		PROVIDERS.high.check.mockRejectedValue(new Error('Source unavailable'));
		await expect(match(1)).resolves.toMatchObject({
			source: 'low',
			format: 'flac',
			bitDepth: 16,
		});
	});
});
