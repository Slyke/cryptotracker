import adapter from '@sveltejs/adapter-node';

const config = {
  kit: {
    adapter: adapter({
      out: 'build'
    }),
    csp: {
      mode: 'nonce',
      directives: {
        'default-src': ['self'],
        'script-src': ['self'],
        'script-src-attr': ['none'],
        'style-src': ['self', 'unsafe-inline'],
        'img-src': ['self', 'data:', 'blob:'],
        'connect-src': ['self'],
        'font-src': ['self'],
        'object-src': ['none'],
        'base-uri': ['self'],
        'frame-ancestors': ['none'],
        'form-action': ['self']
      }
    }
  }
};

export default config;
