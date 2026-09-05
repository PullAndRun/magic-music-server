// FLAC STREAMINFO layout: https://www.rfc-editor.org/rfc/rfc9639.html#section-8.2
const readFlacMetadata = (buffer, size) => {
	if (
		buffer.length < 42 ||
		buffer.toString('ascii', 0, 4) !== 'fLaC' ||
		(buffer[4] & 0x7f) !== 0 ||
		buffer.readUIntBE(5, 3) !== 34
	)
		return null;

	const sampleRate = buffer.readUIntBE(18, 3) >>> 4;
	const channels = ((buffer[20] >> 1) & 7) + 1;
	const bitDepth = (((buffer[20] & 1) << 4) | (buffer[21] >> 4)) + 1;
	const totalSamples =
		(buffer[21] & 0x0f) * 0x100000000 + buffer.readUInt32BE(22);
	if (!sampleRate || bitDepth < 4) return null;

	const duration = totalSamples ? totalSamples / sampleRate : null;
	return {
		format: 'flac',
		lossless: true,
		sampleRate,
		bitDepth,
		channels,
		duration,
		// This is the average file bitrate, including container metadata.
		br:
			duration && Number.isSafeInteger(size) && size > 0
				? Math.round((size * 8) / duration)
				: null,
	};
};

const selectPreferredAudio = (first, second) => {
	const losslessDifference =
		Number(Boolean(first.lossless)) - Number(Boolean(second.lossless));
	if (losslessDifference) return losslessDifference > 0 ? first : second;

	// Compression ratio does not determine lossless audio quality.
	if (first.lossless && second.lossless) {
		for (const key of ['bitDepth', 'sampleRate']) {
			const difference = (first[key] || 0) - (second[key] || 0);
			if (difference) return difference > 0 ? first : second;
		}
	}
	return (first.br || 0) >= (second.br || 0) ? first : second;
};

module.exports = { readFlacMetadata, selectPreferredAudio };
