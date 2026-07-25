export const DDEV_GENERATED_BOUNDARY_MARKER = '<haive_ddev_generated_boundary>';

/** Prompt contract paired with the read-only masks over `#ddev-generated` files.
 *
 * The mask makes the write fail; this explains why, and — more importantly — says what to
 * do instead. Without it an agent reads DDEV's own advice ("remove the #ddev-generated
 * line and ddev will respect the file"), hits a read-only mount, and treats it as a
 * workspace permission fault to route around rather than a policy it should follow. */
export const DDEV_GENERATED_BOUNDARY_PROMPT = [
  DDEV_GENERATED_BOUNDARY_MARKER,
  'DDEV generated-file boundary:',
  'Files under `.ddev/` that contain the `#ddev-generated` marker are mounted read-only on purpose.',
  'This is a Haive containment boundary, not repository corruption or a workspace permission problem.',
  'DDEV owns those files and rewrites them on every start. Removing the marker to "take over" a file',
  "freezes it forever and has broken whole environments: dropping DDEV's own",
  '`Alias "/phpstatus" "/var/www/phpstatus.php"` from `apache-site.conf` makes the web container fail',
  'its healthcheck, so every later `ddev start` times out.',
  'To customize the webserver, ADD a sibling file instead — `.ddev/apache/<project>.conf` or',
  '`.ddev/nginx_full/<project>.conf`. DDEV loads every `*.conf` in those directories, so your rules',
  'apply without touching the generated one.',
  'Files without the marker (`.ddev/config.yaml`, `.ddev/web-build/Dockerfile`, your own `*.conf`)',
  'are yours to edit normally.',
  'When you edit `.ddev/web-build/Dockerfile` or `.ddev/db-build/Dockerfile`, remember what DDEV',
  'builds them on top of: `ddev/ddev-webserver`, which is Debian with ondrej PHP packages — NOT an',
  'official `php:*` image. `docker-php-ext-install`, `docker-php-ext-enable`, `docker-php-source`,',
  '`pecl` and Alpine `apk` are not installed there, so a RUN line calling one fails the image build',
  'with "command not found" on every later start. Check first whether you need the extension at all:',
  'mysql, mysqli, pdo_mysql, gd, curl and intl are already compiled in. To add a package, prefer',
  '`webimage_extra_packages: ["php${DDEV_PHP_VERSION}-<ext>"]` in `.ddev/config.yaml`; from a build',
  'Dockerfile use `apt-get update && apt-get install -y php${DDEV_PHP_VERSION}-<ext>`.',
  '</haive_ddev_generated_boundary>',
].join('\n');

/** Prepend the contract once. The marker makes this safe when nested prompt builders or
 * retry paths apply the same boundary more than once. */
export function withDdevGeneratedBoundary(prompt: string, enabled: boolean): string {
  if (!enabled || prompt.includes(DDEV_GENERATED_BOUNDARY_MARKER)) return prompt;
  return `${DDEV_GENERATED_BOUNDARY_PROMPT}\n\n${prompt}`;
}
