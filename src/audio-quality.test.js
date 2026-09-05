const { readFlacMetadata, selectPreferredAudio } = require('./audio-quality');
const flac = require('./testdata/flac');

describe('FLAC metadata', () => {
	test('reads the independent example from RFC 9639, appendix D.1.1', () => {
		const example = Buffer.from(
			'664c6143800000221000100000000f00000f0ac442f0000000013e84b41807dc690307586a3dad1a2e0f',
			'hex'
		);
		expect(readFlacMetadata(example)).toEqual({
			format: 'flac',
			lossless: true,
			sampleRate: 44100,
			bitDepth: 16,
			channels: 2,
			duration: 1 / 44100,
			br: null,
		});
	});

	test('reads 24-bit/96 kHz and calculates average file bitrate', () => {
		expect(
			readFlacMetadata(
				flac({ sampleRate: 96000, bitDepth: 24, totalSamples: 960000 }),
				5000000
			)
		).toMatchObject({
			sampleRate: 96000,
			bitDepth: 24,
			duration: 10,
			br: 4000000,
		});
	});

	test('keeps all 36 bits of the sample count', () => {
		const totalSamples = 2 ** 32 + 44100;
		expect(readFlacMetadata(flac({ totalSamples })).duration).toBe(
			totalSamples / 44100
		);
	});

	test('does not invent a bitrate when duration or size is unknown', () => {
		expect(
			readFlacMetadata(flac({ totalSamples: 0 }), 1000000)
		).toMatchObject({ duration: null, br: null, format: 'flac' });
		expect(readFlacMetadata(flac(), 0).br).toBeNull();
	});

	test('rejects truncated, non-FLAC and invalid streaminfo blocks', () => {
		expect(readFlacMetadata(Buffer.from('fLaC'))).toBeNull();
		expect(readFlacMetadata(Buffer.alloc(8192))).toBeNull();
		const invalid = flac();
		invalid[7] = 33;
		expect(readFlacMetadata(invalid)).toBeNull();
		expect(readFlacMetadata(flac({ sampleRate: 0 }))).toBeNull();
	});
});

describe('audio quality selection', () => {
	test('prefers lossless audio even if it compresses below MP3 bitrate', () => {
		const lossless = { lossless: true, br: 250000 };
		expect(selectPreferredAudio({ br: 320000 }, lossless)).toBe(lossless);
	});

	test('prefers bit depth, then sample rate, before compressed file bitrate', () => {
		const cd = {
			lossless: true,
			bitDepth: 16,
			sampleRate: 44100,
			br: 1500000,
		};
		const highDepth = {
			lossless: true,
			bitDepth: 24,
			sampleRate: 44100,
			br: 1000000,
		};
		const highRate = { ...highDepth, sampleRate: 96000, br: 900000 };
		expect(selectPreferredAudio(cd, highDepth)).toBe(highDepth);
		expect(selectPreferredAudio(highDepth, highRate)).toBe(highRate);
	});

	test('compares bitrate for lossy streams and preserves ties', () => {
		const first = { br: 320000 };
		expect(selectPreferredAudio(first, { br: 128000 })).toBe(first);
		expect(selectPreferredAudio(first, { br: null })).toBe(first);
		expect(selectPreferredAudio(first, { br: 320000 })).toBe(first);
	});
});
