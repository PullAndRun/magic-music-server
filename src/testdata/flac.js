module.exports = ({
	sampleRate = 44100,
	bitDepth = 16,
	channels = 2,
	totalSamples = 441000,
} = {}) => {
	const buffer = Buffer.alloc(8192);
	buffer.write('fLaC');
	buffer[4] = 0x80;
	buffer.writeUIntBE(34, 5, 3);
	buffer.writeUInt16BE(4096, 8);
	buffer.writeUInt16BE(4096, 10);
	const packed =
		(BigInt(sampleRate) << 44n) |
		(BigInt(channels - 1) << 41n) |
		(BigInt(bitDepth - 1) << 36n) |
		BigInt(totalSamples);
	buffer.writeBigUInt64BE(packed, 18);
	return buffer;
};
