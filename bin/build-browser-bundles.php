<?php

/**
 * @package    Joomla Playground
 * @license    GNU General Public License version 2 or later
 *
 * Builds a browser bundle (bin/build-browser-bundle.php) for every Joomla version in joomla-versions.json, and the
 * list the playground chooses from.
 *
 * Besides the releases, there are bundles of the development branches, from their nightly builds (listed by Joomla's
 * update server, update.joomla.org/core/nightlies, and on https://developer.joomla.org/nightly-builds.html):
 * - the development branch: the next minor version after the default (6.2.0 -> 6.3-dev). Most pull requests of
 *   joomla-cms are for that branch. When the next minor version is released and becomes the default
 *   (scripts/update-joomla-versions.mjs), it moves on to the minor version after it.
 * - the branch of each release in the list (6.2-dev, 5.4-dev): its next patch release. A pull request for such a
 *   branch is tested against the branch as it is now, not against its last release.
 *
 * Usage:
 *   php bin/build-browser-bundles.php [--out=web/public/joomla] [--version=<one version>|development]
 *                                     [--no-languages] [--no-development] [--development-optional]
 *
 * --version=development builds the bundles of all development branches; --no-development builds none.
 * --development-optional leaves out a development branch whose nightly build cannot be downloaded (and has no copy
 * in .cache/), instead of failing: for CI, where developer.joomla.org now and then gives a bot check instead.
 *
 * Output (in --out):
 *   <version>/     one bundle: site.zip, media/, manifest.json, and languages/ with the accredited language packs
 *                  (bin/download-language-packs.php), unless --no-languages. A bundle of a development branch is
 *                  in the folder of its version number (6.3.0/, 6.2.1/); its manifest has the branch
 *                  ("branch": "6.3-dev") and the nightly's version ("development": "6.3.0-alpha1-dev").
 *   versions.json  { "default": "6.2.0", "versions": [ <manifest of each bundle: the development branches first,
 *                  newest first, then the releases>, ... ] }
 *   joomla-core-loader.js, joomla-favicon.svg
 *                  Joomla's loader web component and favicon, from the default bundle
 *
 * A Full Package that is not in .cache/ yet is downloaded from the joomla/joomla-cms releases on GitHub; a nightly
 * build again when the one in .cache/ is older than 12 hours. At the end, the files of the playground's own
 * blueprints are downloaded too (bin/download-blueprint-assets.php).
 */

const PLAYGROUND_ROOT = __DIR__ . '/..';

$options  = getopt('', ['out:', 'version:', 'no-languages', 'no-development', 'development-optional']);
$optional = isset($options['development-optional']);
$out      = $options['out'] ?? PLAYGROUND_ROOT . '/web/public/joomla';
$list     = json_decode(file_get_contents(PLAYGROUND_ROOT . '/joomla-versions.json'), true, flags: JSON_THROW_ON_ERROR);

if (!\in_array($list['default'], $list['versions'], true)) {
    fail('joomla-versions.json: the default version is not in the list');
}

// The development branches by the version number of their bundle.
$developments = isset($options['no-development']) ? [] : array_column(developmentBranches($list, $optional), null, 'version');

$all      = [...array_keys($developments), ...$list['versions']];
$versions = match ($options['version'] ?? null) {
    null          => $all,
    'development' => $developments ? array_keys($developments) : fail('No development branch'),
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

    $development = $developments[$version] ?? null;

    if ($development) {
        // A nightly build: downloaded again when the copy in .cache/ is older than 12 hours. When that fails, the
        // older copy will do; without one, --development-optional leaves the branch out.
        $package = PLAYGROUND_ROOT . '/.cache/' . basename($development['url']);

        if ((!is_file($package) || filemtime($package) < time() - 12 * 3600) && !download($development['url'], $package)) {
            if (is_file($package)) {
                echo '  Using the copy in .cache/ of ' . date('Y-m-d H:i', filemtime($package)) . "\n";
            } elseif ($optional) {
                echo "== Leaving out {$development['branch']}: no nightly build (--development-optional)\n";
                $all = array_values(array_diff($all, [$version]));

                continue;
            } else {
                fail('Cannot download ' . $development['url'] . ' (--development-optional leaves the branch out)');
            }
        }
    } else {
        $package = PLAYGROUND_ROOT . '/.cache/Joomla_' . $version . '-Stable-Full_Package.zip';
        $url     = 'https://github.com/joomla/joomla-cms/releases/download/' . $version . '/' . basename($package);

        is_file($package) || download($url, $package) || fail('Cannot download ' . $url);
    }

    echo "== Joomla $version" . ($development ? ' (' . $development['branch'] . ', nightly build ' . $development['nightly'] . ')' : '') . "\n";
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
    $branch   = $development ? ['branch' => $development['branch'], 'development' => $development['nightly']] : [];
    file_put_contents($file, json_encode([...$manifest, ...$branch, 'languages' => $languages], JSON_PRETTY_PRINT) . "\n");
}

$manifests = [];

foreach ($all as $version) {
    $file = $out . '/' . $version . '/manifest.json';
    is_file($file) || fail('No bundle of Joomla ' . $version . ' in ' . $out);
    $manifests[] = json_decode(file_get_contents($file), true);
}

file_put_contents($out . '/versions.json', json_encode(['default' => $list['default'], 'versions' => $manifests], JSON_PRETTY_PRINT) . "\n");

// Joomla's loader and favicon, which the page shows while a playground starts (before it knows which bundle it will use).
copy($out . '/' . $list['default'] . '/media/system/js/joomla-core-loader.min.js', $out . '/joomla-core-loader.js')
    || fail('No joomla-core-loader.min.js in the bundle of Joomla ' . $list['default']);
copy($out . '/' . $list['default'] . '/media/system/images/joomla-favicon.svg', $out . '/joomla-favicon.svg')
    || fail('No joomla-favicon.svg in the bundle of Joomla ' . $list['default']);

echo "== Files of the playground's blueprints\n";
$process = proc_open([PHP_BINARY, __DIR__ . '/download-blueprint-assets.php'], [1 => STDOUT, 2 => STDERR], $pipes);
proc_close($process) === 0 || fail('Downloading the files of the blueprints failed');

echo "\nBundles: " . implode(', ', $all) . ' (default ' . $list['default'] . ")\n";

/**
 * The development branches, from their nightly builds: first the next minor version after the default (6.2.0 -> 6.3,
 * or else the next major version), then the branch of each release in the list (6.2-dev, 5.4-dev), if it has a
 * nightly build newer than that release.
 *
 * @return  list<array{version: string, branch: string, nightly: string, url: string}>
 */
function developmentBranches(array $list, bool $optional): array
{
    // The nightly builds Joomla's update server offers (next patch, minor and major version), as Joomla Update gets
    // them. The page on developer.joomla.org lists them too, but GitHub Actions sometimes gets a "One moment,
    // please..." bot check instead; it is only asked when the update server gives none. Each is tried three times.
    $context  = stream_context_create(['http' => ['timeout' => 30, 'user_agent' => 'Joomla Playground build (https://github.com/joomla-projects/joomla-playground)']]);
    $source   = 'https://update.joomla.org/core/nightlies/';
    $versions = [];

    foreach (['patch', 'minor', 'major'] as $next) {
        $versions = [...$versions, ...nightlyVersions($source . 'next_' . $next . '_list.xml', $context)];
    }

    if (!$versions) {
        $source = 'https://developer.joomla.org/nightly-builds.html';
        echo "  No nightly builds from the update server; trying $source\n";
        $versions = nightlyVersions($source, $context);
    }

    if (!$versions && $optional) {
        echo "== No development branches: no nightly builds from the update server nor $source (--development-optional)\n";

        return [];
    }

    if (!$versions) {
        fail("No nightly builds from the update server nor $source (--no-development or --development-optional builds without the development branches)");
    }

    // The newest nightly build of each minor version.
    usort($versions, static fn (string $a, string $b): int => version_compare($b, $a));

    $matches = [];

    foreach (array_unique($versions) as $version) {
        preg_match('/^(\d+)\.(\d+)\.(\d+)/', $version, $number);
        $matches[] = ["https://developer.joomla.org/nightlies/Joomla_$version-Development-Full_Package.zip", $version, $number[1], $number[2], $number[3]];
    }

    $nightlies = [];

    foreach ($matches as [$url, $nightly, $major, $minor, $patch]) {
        $nightlies["$major.$minor"] ??= ['key' => [(int) $major, (int) $minor], 'version' => "$major.$minor.$patch", 'branch' => "$major.$minor-dev", 'nightly' => $nightly, 'url' => $url];
    }

    $minorOf = static fn (string $version): array => array_map('intval', \array_slice(explode('.', $version), 0, 2));
    $default = $minorOf($list['default']);
    $next    = null;

    foreach ($nightlies as $candidate) {
        // Newer than the default's minor version, and the closest to it.
        if ($candidate['key'] > $default && (!$next || $candidate['key'] < $next['key'])) {
            $next = $candidate;
        }
    }

    if (!$next) {
        fail('No nightly build newer than Joomla ' . $list['default'] . ' on ' . $source);
    }

    if (\in_array($next['version'], $list['versions'], true)) {
        fail('Joomla ' . $next['version'] . ' is released: update joomla-versions.json (scripts/update-joomla-versions.mjs)');
    }

    $branches = [$next];

    foreach ($list['versions'] as $release) {
        $nightly = $nightlies[implode('.', $minorOf($release))] ?? null;

        // A branch without a nightly build (no longer maintained), or whose nightly build is not newer than the
        // release yet (just released): the release is all there is.
        if (!$nightly || version_compare($nightly['version'], $release, '<=')) {
            echo "== No nightly build newer than Joomla $release\n";

            continue;
        }

        $branches[] = $nightly;
    }

    return array_map(static function (array $branch): array {
        unset($branch['key']);

        return $branch;
    }, $branches);
}

/**
 * The versions of the nightly builds (6.3.0-alpha2-dev, 5.4.12-dev) on a list of the update server or on the nightly
 * builds page; none when it has none after three tries.
 *
 * @param   resource  $context
 *
 * @return  list<string>
 */
function nightlyVersions(string $url, $context): array
{
    $pattern = str_ends_with($url, '.xml')
        ? '#version="(\d+\.\d+\.\d+[^"/]*-dev)"#'
        : '#https://developer\.joomla\.org/nightlies/Joomla_(\d+\.\d+\.\d+[^"/]*)-Development-Full_Package\.zip#';

    for ($attempt = 1; $attempt <= 3; $attempt++) {
        $page = @file_get_contents($url, false, $context);

        if ($page !== false && preg_match_all($pattern, $page, $matches)) {
            return array_values(array_unique($matches[1]));
        }

        $what = $page === false ? 'no answer' : \strlen($page) . ' bytes without nightly builds: ' . substr(preg_replace('/\s+/', ' ', strip_tags($page)), 0, 200);
        echo "  $url: $what" . ($attempt < 3 ? '; trying again in 20 seconds' : '') . "\n";
        $attempt < 3 && sleep(20);
    }

    return [];
}

/**
 * Downloads a zip, three tries; a page instead of a zip (a bot check, an error page) does not count.
 *
 * @return  bool  Whether the zip is there
 */
function download(string $url, string $file): bool
{
    echo "== Downloading $url\n";
    is_dir(\dirname($file)) || mkdir(\dirname($file), 0755, true);

    for ($attempt = 1; $attempt <= 3; $attempt++) {
        if (@copy($url, $file . '.part') && file_get_contents($file . '.part', false, null, 0, 4) === "PK\x03\x04") {
            rename($file . '.part', $file);

            return true;
        }

        @unlink($file . '.part');

        if ($attempt < 3) {
            echo "  No zip from $url; trying again in 20 seconds\n";
            sleep(20);
        }
    }

    echo "  No zip from $url\n";

    return false;
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
