const {
	isHost,
	isHostWrapper,
	cookieToMap,
	mapToCookie,
} = require('./utilities');

describe('isHost()', () => {
	test.each([
		['https://music.163.com/song/1', 'music.163.com'],
		['https://sub.music.163.com/song/1', 'music.163.com'],
		['MUSIC.163.COM:443', 'music.163.com'],
	])('matches %s against %s', (url, host) => {
		expect(isHost(url, host)).toBe(true);
	});

	test.each([
		['https://music.163.com.example.com', 'music.163.com'],
		['https://example.com/?next=music.163.com', 'music.163.com'],
		['/song/music.163.com', 'music.163.com'],
	])('rejects %s as %s', (url, host) => {
		expect(isHost(url, host)).toBe(false);
	});

	test('provides a host-specific wrapper', () => {
		const matches = isHostWrapper('https://cdn.bilivideo.com/audio.m4s');

		expect(matches('bilivideo.com')).toBe(true);
		expect(matches('example.com')).toBe(false);
	});
});

describe('cookie conversion', () => {
	it('handles missing cookies and preserves equals signs in values', () => {
		expect(cookieToMap()).toEqual({});
		expect(cookieToMap('token=a=b==; theme=dark; invalid')).toEqual({
			token: 'a=b==',
			theme: 'dark',
		});
	});

	it('serializes a cookie map', () => {
		expect(mapToCookie({ token: 'a=b==', theme: 'dark' })).toBe(
			'token=a=b==; theme=dark'
		);
	});
});
