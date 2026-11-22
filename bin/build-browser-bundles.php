<?php

/**
 * @package    Joomla Playground
 * @license    GNU General Public License version 2 or later
 *
 * Builds a browser bundle (bin/build-browser-bundle.php) for every Joomla version in joomla-versions.json, and the
 * list the playground chooses from.
 *
 * Besides the releases, there is a bundle of the development branch: the nightly build of the next minor version
 * after the default (6.2.0 -> 6.3-dev), from https://developer.joomla.org/nightly-builds.html. Most pull requests of
 * joomla-cms are for that branch. When the next minor version is released and becomes the default
 * (scripts/update-joomla-versions.mjs), the development bundle moves on to the minor version after it.
 *
 * Usage:
 *   php bin/build-browser-bundles.php [--out=web/public/joomla] [--version=<one version>|development]
 *                                     [--no-languages] [--no-development]
 *
 * Output (in --out):
 *   <version>/     one bundle: site.zip, media/, manifest.json, and languages/ with the accredited language packs
 *                  (bin/download-language-packs.php), unless --no-languages. The development bundle is in the
 *                  folder of its version number (6.3.0/); its manifest has "branch": "6.3-dev" and the nightly's
 *                  version ("development": "6.3.0-alpha1-dev").
 *   versions.json  { "default": "6.2.0", "versions": [ <manifest of each bundle, the development branch first>, ... ] }
 *
 * A Full Package that is not in .cache/ yet is downloaded from the joomla/joomla-cms releases on GitHub; a nightly
 * build again when the one in .cache/ is older than 12 hours. At the end, the files of the playground's own
 * blueprints are downloaded too (bin/download-blueprint-assets.php).
 */

const PLAYGROUND_ROOT = __DIR__ . '/..';

$options  = getopt('', ['out:', 'version:', 'no-languages', 'no-development']);
$out      = $options['out'] ?? PLAYGROUND_ROOT . '/web/public/joomla';
$list     = json_decode(file_get_contents(PLAYGROUND_ROOT . '/joomla-versions.json'), true, flags: JSON_THROW_ON_ERROR);

if (!\in_array($list['default'], $list['versions'], true)) {
    fail('joomla-versions.json: the default version is not in the list');
}

$development = isset($options['no-development']) ? null : developmentBranch($list['default']);

if ($development && \in_array($development['version'], $list['versions'], true)) {
    fail('Joomla ' . $development['version'] . ' is released: update joomla-versions.json (scripts/update-joomla-versions.mjs)');
}

$all      = [...($development ? [$development['version']] : []), ...$list['versions']];
$versions = match ($options['version'] ?? null) {
    null          => $all,
    'development' => $development ? [$development['version']] : fail('No development branch'),
    default       => [$options['version']],
};

// Bundles of the old layout (one version directly in --out) and of versions no longer listed go.
if (!isset($options['version']) && is_dir($out)) {
    foreach (scandir($out) as $name) {
        if ($name !== '.' && $name !== '..' && is_dir($out . '/' . $name) && !\in_array($name, $all, true)) {
            removeTree($out . '/' . $name);
        }
    }
}

foreach ($versions as $version) {
    if (!preg_match('/^\d+\.\d+\.\d+$/', $version)) {
        fail('Not a stable Joomla version: ' . $version);
    }

    if ($version === ($development['version'] ?? null)) {
        // A nightly build: downloaded again when the copy in .cache/ is older than 12 hours.
        $package = PLAYGROUND_ROOT . '/.cache/' . basename($development['url']);

        if (!is_file($package) || filemtime($package) < time() - 12 * 3600) {
            download($development['url'], $package);
        }
    } else {
        $package = PLAYGROUND_ROOT . '/.cache/Joomla_' . $version . '-Stable-Full_Package.zip';

        if (!is_file($package)) {
            download('https://github.com/joomla/joomla-cms/releases/download/' . $version . '/' . basename($package), $package);
        }
    }

    echo "== Joomla $version" . ($version === ($development['version'] ?? null) ? ' (' . $development['branch'] . ', nightly build ' . $development['nightly'] . ')' : '') . "\n";
    $process = proc_open(
        [PHP_BINARY, __DIR__ . '/build-browser-bundle.php', '--package=' . $package, '--out=' . $out . '/' . $version],
        [1 => STDOUT, 2 => STDERR],
        $pipes,
        null,
        [...getenv(), 'JOOMLA_VERSION' => $version]
    );

    proc_close($process) === 0 || fail('Building the bundle of Joomla ' . $version . ' failed');

    $languages = 0;

    if (!isset($options['no-languages'])) {
        echo "== Language packs for Joomla $version\n";
        $process = proc_open(
            [PHP_BINARY, __DIR__ . '/download-language-packs.php', '--joomla=' . $version, '--out=' . $out . '/' . $version . '/languages'],
            [1 => STDOUT, 2 => STDERR],
            $pipes
        );
        proc_close($process) === 0 || fail('Downloading the language packs of Joomla ' . $version . ' failed');
        $languages = \count(json_decode(file_get_contents($out . '/' . $version . '/languages/index.json'), true)['packs']);
    }

    // The playground uses the language packs of a bundle when its manifest counts them.
    $file     = $out . '/' . $version . '/manifest.json';
    $manifest = json_decode(file_get_contents($file), true);
    $branch   = $version === ($development['version'] ?? null) ? ['branch' => $development['branch'], 'development' => $development['nightly']] : [];
    file_put_contents($file, json_encode([...$manifest, ...$branch, 'languages' => $languages], JSON_PRETTY_PRINT) . "\n");
}

$manifests = [];

foreach ($all as $version) {
    $file = $out . '/' . $version . '/manifest.json';
    is_file($file) || fail('No bundle of Joomla ' . $version . ' in ' . $out);
    $manifests[] = json_decode(file_get_contents($file), true);
}

file_put_contents($out . '/versions.json', json_encode(['default' => $list['default'], 'versions' => $manifests], JSON_PRETTY_PRINT) . "\n");

// Joomla's loader, which the page shows while a playground starts (before it knows which bundle it will use).
copy($out . '/' . $list['default'] . '/media/system/js/joomla-core-loader.min.js', $out . '/joomla-core-loader.js')
    || fail('No joomla-core-loader.min.js in the bundle of Joomla ' . $list['default']);

echo "== Files of the playground's blueprints\n";
$process = proc_open([PHP_BINARY, __DIR__ . '/download-blueprint-assets.php'], [1 => STDOUT, 2 => STDERR], $pipes);
proc_close($process) === 0 || fail('Downloading the files of the blueprints failed');

echo "\nBundles: " . implode(', ', $all) . ' (default ' . $list['default'] . ")\n";

/**
 * The development branch after a release: the nightly build of the next minor version (6.2.0 -> 6.3), or else of
 * the next major version.
 *
 * @return  array{version: string, branch: string, nightly: string, url: string}|null
 */
function developmentBranch(string $default): ?array
{
    // The page may fail now and then, or come without the list (seen once on GitHub Actions): try three times.
    $source  = 'https://developer.joomla.org/nightly-builds.html';
    $context = stream_context_create(['http' => ['timeout' => 30, 'user_agent' => 'Joomla Playground build (https://github.com/joomla-projects/joomla-playground)']]);
    $pattern = '#https://developer\.joomla\.org/nightlies/Joomla_((\d+)\.(\d+)\.(\d+)[^"/]*)-Development-Full_Package\.zip#';

    for ($attempt = 1; ; $attempt++) {
        $page    = @file_get_contents($source, false, $context);
        $matches = [];

        if ($page !== false && preg_match_all($pattern, $page, $matches, PREG_SET_ORDER)) {
            break;
        }

        $what = $page === false ? 'no answer' : \strlen($page) . ' bytes without nightly builds: ' . substr(preg_replace('/\s+/', ' ', strip_tags($page)), 0, 200);

        if ($attempt === 3) {
            fail("$source: $what (--no-development builds without the development branch)");
        }

        echo "  $source: $what; trying again in 20 seconds
";
        sleep(20);
    }
    [$major, $minor] = array_map('intval', explode('.', $default));
    $next = null;

    foreach ($matches as [$url, $nightly, $nightlyMajor, $nightlyMinor, $patch]) {
        $key = [(int) $nightlyMajor, (int) $nightlyMinor];

        // Newer than the default's minor version, and the closest to it.
        if ($key > [$major, $minor] && (!$next || $key < $next['key'])) {
            $next = ['key' => $key, 'version' => "$nightlyMajor.$nightlyMinor.$patch", 'branch' => "$nightlyMajor.$nightlyMinor-dev", 'nightly' => $nightly, 'url' => $url];
        }
    }

    if (!$next) {
        fail('No nightly build newer than Joomla ' . $default . ' on https://developer.joomla.org/nightly-builds.html');
    }

    unset($next['key']);

    return $next;
}

function download(string $url, string $file): void
{
    echo "== Downloading $url\n";
    is_dir(\dirname($file)) || mkdir(\dirname($file), 0755, true);
    copy($url, $file . '.part') && rename($file . '.part', $file) || fail('Cannot download ' . $url);
}

function fail(string $message): never
{
    fwrite(STDERR, 'ERROR: ' . $message . PHP_EOL);
    exit(1);
}

function removeTree(string $path): void
{
    if (is_dir($path) && !is_link($path)) {
        foreach (array_diff(scandir($path), ['.', '..']) as $name) {
            removeTree($path . '/' . $name);
        }

        rmdir($path);
    } elseif (file_exists($path)) {
        unlink($path);
    }
}
