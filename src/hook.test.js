jest.mock('./provider/match', () => jest.fn());
jest.mock('./request', () => ({ read: jest.fn() }));
jest.mock('./logger', () => ({
	logScope: () => ({ debug: jest.fn(), info: jest.fn(), error: jest.fn() }),
}));
const request = require('./request');
const match = require('./provider/match');
const hook = require('./hook');

const runHook = async (item) => {
	request.read.mockResolvedValue(
		Buffer.from(JSON.stringify({ code: 200, data: [item] }))
	);
	const ctx = {
		req: {
			headers: { host: 'music.163.com', cookie: '' },
			url: 'http://music.163.com/api/song/enhance/player/url',
		},
		proxyRes: { headers: {}, statusCode: 200 },
		netease: {
			path: '/api/song/enhance/player/url',
			param: { ids: '[1]', header: { os: 'pc' } },
		},
	};
	await hook.request.after(ctx);
	return JSON.parse(ctx.proxyRes.body).data[0];
};

const originalThreshold = process.env.MIN_BR;
beforeEach(() => {
	process.env.MIN_BR = '999000';
	match.mockResolvedValue({
		url: 'http://audio.test/song.flac',
		br: 1642935,
		size: 55397039,
		format: 'flac',
		lossless: true,
	});
});
afterEach(() => {
	if (originalThreshold === undefined) delete process.env.MIN_BR;
	else process.env.MIN_BR = originalThreshold;
	jest.clearAllMocks();
});

test('preserves FLAC type and real bitrate in the client response', async () => {
	expect(await runHook({ id: 1, code: 404, br: 0 })).toMatchObject({
		type: 'flac',
		br: 1642935,
		code: 200,
	});
});

test('upgrades a playable MP3 below the threshold to lossless', async () => {
	expect(
		await runHook({
			id: 1,
			code: 200,
			br: 320000,
			type: 'mp3',
			url: 'http://audio.test/original.mp3',
		})
	).toMatchObject({
		type: 'flac',
		br: 1642935,
		url: 'http://audio.test/song.flac',
	});
});

test('retains a playable original if the replacement has lower bitrate', async () => {
	match.mockResolvedValue({ url: 'http://audio.test/low.mp3', br: 128000 });
	const original = {
		id: 1,
		code: 200,
		br: 320000,
		type: 'mp3',
		url: 'http://audio.test/original.mp3',
	};
	expect(await runHook(original)).toMatchObject(original);
});

test('retains an existing FLAC when its actual specification is unknown', async () => {
	const original = {
		id: 1,
		code: 200,
		br: 800000,
		type: 'flac',
		url: 'http://audio.test/original.flac',
	};
	expect(await runHook(original)).toMatchObject(original);
});

test('retains the original when all replacement sources fail', async () => {
	match.mockRejectedValue(new Error('No sources available'));
	const original = {
		id: 1,
		code: 200,
		br: 320000,
		type: 'mp3',
		url: 'http://audio.test/original.mp3',
	};
	expect(await runHook(original)).toMatchObject(original);
});

test('does not replace an original at or above the threshold', async () => {
	const original = {
		id: 1,
		code: 200,
		br: 1642935,
		type: 'flac',
		url: 'http://audio.test/original.flac',
	};
	expect(await runHook(original)).toMatchObject(original);
	expect(match).not.toHaveBeenCalled();
});
