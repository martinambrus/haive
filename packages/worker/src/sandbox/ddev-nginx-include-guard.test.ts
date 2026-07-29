import { describe, expect, it } from 'vitest';
import { findDdevNginxIncludeCollisions, locationKeysAtDepth } from './ddev-nginx-include-guard.js';

// Excerpts of the three real files from task a0d1bbf9 (repo rs_codex_5.6_high), the ones
// `nginx -t` rejected with `[emerg] duplicate location "/aliases.ser"`.

// .ddev/nginx_full/rs-codex-5-6-high.conf — the project-authored SECOND server block.
// It ends with DDEV's snippet include, which is what pulls the snippet below into it.
const SITE_SIBLING = `server {
    server_name rs-codex-5-6-high.ddev.site ~^.+$;
    listen 80;
    root /var/www/html;

    location / {
        try_files $uri $uri/ /404.php?$query_string;
    }

    location = /installer {
        access_log off;
        return 301 /installer/;
    }

    location = /aliases.ser {
        deny all;
    }

    include /etc/nginx/common.d/*.conf;
    include /mnt/ddev_config/nginx/*.conf;
}
`;

// .ddev/nginx/rs-codex-5-6-high.conf — the snippet, re-declaring the same locations.
const SNIPPET = `# This file is included inside DDEV's generated default server.
access_log off;

location = /installer {
    access_log off;
    return 301 /installer/;
}

location = /aliases.ser {
    deny all;
}
`;

// DDEV's own generated nginx-site.conf. It carries the same include but shares no location
// key with the snippet, so it must stay silent — this is the file that boots fine.
const GENERATED_SITE = `#ddev-generated
server {
    listen 80 default_server;
    root /var/www/html;

    location / {
        try_files $uri $uri/ /index.php?$query_string;
    }

    location = /favicon.ico {
        access_log off;
    }

    include /etc/nginx/common.d/*.conf;
    include /mnt/ddev_config/nginx/*.conf;
}
`;

describe('locationKeysAtDepth', () => {
  it('reads a server block’s own locations at depth 1 and a snippet’s at depth 0', () => {
    expect(locationKeysAtDepth(SITE_SIBLING, 1)).toEqual(['/', '= /installer', '= /aliases.ser']);
    expect(locationKeysAtDepth(SNIPPET, 0)).toEqual(['= /installer', '= /aliases.ser']);
  });

  it('normalises only the whitespace between modifier and uri', () => {
    expect(locationKeysAtDepth('location   ~*   \\.php$  {\n}\n', 0)).toEqual(['~* \\.php$']);
  });

  it('ignores a location mentioned in a comment', () => {
    expect(locationKeysAtDepth('# location = /installer {\nlocation / {\n}\n', 0)).toEqual(['/']);
  });

  it('ignores locations nested deeper than the level asked for', () => {
    // A location inside another block belongs to that context and cannot collide with the
    // snippets spliced at server level.
    expect(locationKeysAtDepth(SITE_SIBLING, 0)).toEqual([]);
  });
});

describe('findDdevNginxIncludeCollisions', () => {
  it('flags the real rs_codex_5.6_high pair that killed the web container', () => {
    const reason = findDdevNginxIncludeCollisions({
      siteConfs: [
        { name: 'nginx-site.conf', content: GENERATED_SITE },
        { name: 'rs-codex-5-6-high.conf', content: SITE_SIBLING },
      ],
      snippets: [{ name: 'rs-codex-5-6-high.conf', content: SNIPPET }],
    });
    // The exact key `nginx -t` rejected.
    expect(reason).toContain('= /aliases.ser');
    expect(reason).toContain('= /installer');
    expect(reason).toContain('.ddev/nginx_full/rs-codex-5-6-high.conf');
    expect(reason).toContain('.ddev/nginx/rs-codex-5-6-high.conf');
  });

  it('passes a stock DDEV project with no snippets at all', () => {
    expect(
      findDdevNginxIncludeCollisions({
        siteConfs: [{ name: 'nginx-site.conf', content: GENERATED_SITE }],
        snippets: [],
      }),
    ).toBeNull();
  });

  it('passes a snippet whose locations the server block does not also declare', () => {
    // The supported pattern: rules live in the snippet only, so every server block that
    // includes it gets them exactly once.
    expect(
      findDdevNginxIncludeCollisions({
        siteConfs: [{ name: 'nginx-site.conf', content: GENERATED_SITE }],
        snippets: [{ name: 'custom.conf', content: SNIPPET }],
      }),
    ).toBeNull();
  });

  it('passes a site conf that does not include the snippet directory', () => {
    // Without DDEV's include the snippet is never spliced into this block, so declaring the
    // same location in both is legal.
    const noInclude = SITE_SIBLING.replace('    include /mnt/ddev_config/nginx/*.conf;\n', '');
    expect(
      findDdevNginxIncludeCollisions({
        siteConfs: [{ name: 'rs-codex-5-6-high.conf', content: noInclude }],
        snippets: [{ name: 'rs-codex-5-6-high.conf', content: SNIPPET }],
      }),
    ).toBeNull();
  });

  it('ignores a location the snippet only mentions in a comment', () => {
    expect(
      findDdevNginxIncludeCollisions({
        siteConfs: [{ name: 'rs.conf', content: SITE_SIBLING }],
        snippets: [{ name: 'notes.conf', content: '# location = /aliases.ser is handled above\n' }],
      }),
    ).toBeNull();
  });
});
