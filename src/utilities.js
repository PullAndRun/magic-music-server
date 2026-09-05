/**
 * Does the hostname of `URL` equal `host`?
 *
 * @param url {string}
 * @param host {string}
 * @return {boolean}
 */
const isHost = (url, host) => {
	const getHostname = (value) => {
		if (typeof value !== 'string') return '';
		const candidate = value.trim();
		if (!candidate || candidate.startsWith('/')) return '';

		try {
			const parsed = new URL(
				/^[a-z][a-z\d+.-]*:\/\//i.test(candidate)
					? candidate
					: `http://${candidate}`
			);
			return parsed.hostname.toLowerCase().replace(/\.$/, '');
		} catch {
			return '';
		}
	};

	const hostname = getHostname(url);
	const expected = getHostname(host);
	return (
		Boolean(hostname && expected) &&
		(hostname === expected || hostname.endsWith(`.${expected}`))
	);
};

/**
 * The wrapper of `isHost()` to simplify the code.
 *
 * @param url {string}
 * @return {(host: string) => boolean}
 * @see isHost
 */
const isHostWrapper = (url) => (host) => isHost(url, host);

const cookieToMap = (cookie = '') =>
	cookie.split(';').reduce((result, entry) => {
		const separator = entry.indexOf('=');
		if (separator <= 0) return result;

		const key = entry.slice(0, separator).trim();
		const value = entry.slice(separator + 1).trim();
		if (key) result[key] = value;
		return result;
	}, {});

const mapToCookie = (map) => {
	return Object.entries(map)
		.map(([key, value]) => `${key}=${value}`)
		.join('; ');
};

module.exports = {
	isHost,
	isHostWrapper,
	cookieToMap,
	mapToCookie,
};
