import fsExtra from 'fs-extra';
import path from 'path';
import { performance } from 'perf_hooks';
import * as babylon from '@babel/parser';
import traverse from '@babel/traverse';
import generator from '@babel/generator';
import commandLineArgs from 'command-line-args';
import CliProgress from 'cli-progress';
import chalk from 'chalk';
import { isIdentifier } from '@babel/types';
import crypto from 'crypto';
import { ESLint } from 'eslint';
import Module from './module';
import taggerList from './taggers/taggerList';
import editorList from './editors/editorList';
import Router from './router';
import decompilerList from './decompilers/decompilerList';
import CacheParse from './cacheParse';
import { CachedFile } from './cacheModule';
import eslintConfig from './eslintConfig';

interface CmdArgs {
  in: string;
  out: string;
  bundlesFolder: string;
  entry: number;
  performance: boolean;
  verbose: boolean;
  decompileIgnored: boolean;
  agressiveCache: boolean;
  noEslint: boolean;
}

const argValues = commandLineArgs<CmdArgs>([
  { name: 'in', alias: 'i' },
  { name: 'out', alias: 'o' },
  { name: 'entry', alias: 'e', type: Number },
  { name: 'performance', alias: 'p', type: Boolean },
  { name: 'verbose', alias: 'v', type: Boolean },
  { name: 'bundlesFolder', alias: 'b', defaultValue: './js-modules' },
  { name: 'noEslint', type: Boolean },
  { name: 'decompileIgnored', type: Boolean },
  { name: 'agressiveCache', type: Boolean },
]);
if (!argValues.in || !argValues.out) {
  console.log(`react-native-decompiler
Example command: react-native-decompiler -i index.android.bundle -o ./output

Command params:

-i (required) - the path to the import bundle
-o (required) - the path to the output folder
-b - the path to the bundles folder for unbundled apps. Assumed to be "./js-modules" if not set.
-e - a module ID, if specified will only decompile that module & it's dependencies. also creates cache file to speed up future load times (useful for developing new plugins)
-p - performance monitoring flag, will print out runtime for each decompiler plugin
-v - verbose flag, does not include debug logging (use DEBUG=react-native-decompiler:* env flag for that)
--noEslint - does not run ESLint after doing decompilation
--decompileIgnored - decompile ignored modules(modules are generally ignored if they are flagged as an NPM module)
--agressiveCache - skips some cache checks at the expense of possible cache desync`);
  process.exit(1);
}
const progressBar = new CliProgress.SingleBar({ etaBuffer: 200 }, CliProgress.Presets.shades_classic);
const cacheFileName = `${argValues.out}/${argValues.entry ?? 'null'}.cache`;
let startTime = performance.now();

fsExtra.ensureDirSync(argValues.out);

console.log('Reading file...');

let inputJsFile = fsExtra.readFileSync(argValues.in, 'utf8');
if (fsExtra.existsSync(argValues.bundlesFolder)) {
  console.log('Unbundle detected, re-bundling...');

  const unbundleFileNames = fsExtra.readdirSync(argValues.bundlesFolder).filter((file) => file.endsWith('.js'));
  const unbundleFiles = unbundleFileNames.map((fileName) => fsExtra.readFileSync(path.join(argValues.bundlesFolder, fileName)));
  inputJsFile += '\n';
  inputJsFile += unbundleFiles.join('\n');
}
let cacheFile: CachedFile | undefined = fsExtra.existsSync(cacheFileName) ? <CachedFile>fsExtra.readJSONSync(cacheFileName) : undefined;

if (cacheFile) {
  console.log('Cache detected, validating it...');
  if (cacheFile.checksum !== crypto.createHash('md5').update(inputJsFile).digest('hex')) {
    console.log('Cache invalidated due to checksum mismatch');
    fsExtra.removeSync(cacheFileName);
    cacheFile = undefined;
  } else {
    console.log('Cache validated');
  }
} else if (argValues.agressiveCache) {
  console.error('A cache file must be generated first before using the agressive cache');
  process.exit(1);
}

console.log(`Took ${performance.now() - startTime}ms`);
startTime = performance.now();

const modules: Module[] = [];
if (cacheFile) {
  console.log('Loading cache...');

  const validCachedModules = cacheFile.modules.filter((cachedModule) => (!argValues.agressiveCache || !cachedModule.ignored || cachedModule.isNpmModule));
  // const validCachedModules = cacheFile.modules;
  progressBar.start(validCachedModules.length, 0);
  validCachedModules.forEach((cached) => {
    const canIgnoreModuleBody = argValues.agressiveCache && cached.isNpmModule && cached.originalCode.length > 128;
    const originalFile = babylon.parse(canIgnoreModuleBody ? `__d(function(g,r,i,a,m,e,d){},${cached.moduleId},[])` : cached.originalCode);
    traverse(originalFile, {
      CallExpression(nodePath) {
        if (isIdentifier(nodePath.node.callee) && nodePath.node.callee.name === '__d') {
          const module = new Module(nodePath, originalFile);
          module.loadCache(cached);
          modules[module.moduleId] = module;
          progressBar.increment();
        }
        nodePath.skip();
      },
    });
  });
  progressBar.stop();
} else {
  console.log('Parsing JS...');

  const originalFile = babylon.parse(inputJsFile);

  console.log(`Took ${performance.now() - startTime}ms`);
  startTime = performance.now();
  console.log('Finding modules...');

  traverse(originalFile, {
    CallExpression(nodePath) {
      if (isIdentifier(nodePath.node.callee) && nodePath.node.callee.name === '__d') {
        const module = new Module(nodePath, originalFile);
        modules[module.moduleId] = module;
      }
      nodePath.skip();
    },
  });
}

if (modules.length === 0) {
  console.error(`${chalk.red('[!]')} No modules were found!`);
  console.error(`${chalk.red('[!]')} Possible reasons:`);
  console.error(`${chalk.red('[!]')} - The app is unbundled. If it is, export the "js-modules" folder from the app and provide it as the --js-modules argument`);
  console.error(`${chalk.red('[!]')} - The bundle is a binary/encrypted file (ex. Facebook, Instagram). These files are not supported`);
  console.error(`${chalk.red('[!]')} - The file provided is not a React Native bundle.`);
  process.exit(1);
}

if (argValues.entry != null && (!argValues.agressiveCache || !cacheFile)) {
  console.log('Entry module provided, filtering out unused modules');
  const entryModuleDependencies = new Set<number>();
  let lastDependenciesSize = 0;

  entryModuleDependencies.add(argValues.entry);

  while (lastDependenciesSize !== entryModuleDependencies.size) {
    lastDependenciesSize = entryModuleDependencies.size;
    entryModuleDependencies.forEach((moduleId) => {
      const module = modules.find((mod) => mod?.moduleId === moduleId);
      if (!module) {
        if (!argValues.agressiveCache) throw new Error(`Failed to find entry module/dependency ${moduleId}`);
        return;
      }
      module.dependencies.forEach((dep) => entryModuleDependencies.add(dep));
    });
  }

  modules.forEach((mod, i) => {
    if (!entryModuleDependencies.has(mod.moduleId)) {
      delete modules[i];
    }
  });
}

let nonIgnoredModules = modules.filter((mod) => argValues.decompileIgnored || !mod.ignored);

console.log(`Took ${performance.now() - startTime}ms`);
startTime = performance.now();
console.log('Pre-parsing modules...');

progressBar.start(nonIgnoredModules.length, 0);
nonIgnoredModules.forEach((module) => {
  module.initalize();

  progressBar.increment();
});

progressBar.stop();
console.log(`Took ${performance.now() - startTime}ms`);
startTime = performance.now();
console.log('Tagging...');
progressBar.start(nonIgnoredModules.length, 0);
nonIgnoredModules.forEach((module) => {
  const router = new Router(taggerList, module, modules, argValues.performance);
  router.parse(module);

  progressBar.increment();
});

progressBar.stop();
if (argValues.performance) {
  console.log(`Traversal took ${Router.traverseTimeTaken}ms`);
  console.log(Router.timeTaken);
  Router.timeTaken = {};
  Router.traverseTimeTaken = 0;
}
console.log(`Took ${performance.now() - startTime}ms`);
startTime = performance.now();

console.log('Filtering out modules only depended on ignored modules...');

let modulesToIgnore: Module[] = [];
function calculateModulesToIgnore() {
  if (argValues.agressiveCache) return;
  modulesToIgnore = modules.filter((mod) => {
    const dependentModules = modules.filter((otherMod) => otherMod.dependencies.includes(mod.moduleId));
    return !mod.ignored && dependentModules.length > 0 && dependentModules.every((otherMod) => otherMod.ignored || mod.dependencies.includes(otherMod.moduleId));
  });
}
calculateModulesToIgnore();
while (modulesToIgnore.length) {
  modulesToIgnore.forEach((mod) => {
    mod.ignored = true;
  });
  calculateModulesToIgnore();
}

if (argValues.verbose) {
  modules.forEach((mod) => {
    if (mod.ignored && !mod.isNpmModule) return;
    const dependentModules = modules.filter((otherMod) => !otherMod.ignored && otherMod.dependencies.includes(mod.moduleId));
    console.debug(mod.moduleId, mod.moduleName, mod.isNpmModule ? ['X'] : dependentModules.map((m) => m.moduleId));
  });
}

nonIgnoredModules = modules.filter((mod) => argValues.decompileIgnored || !mod.ignored);

console.log(`Took ${performance.now() - startTime}ms`);
startTime = performance.now();
console.log('Decompiling...');
progressBar.start(nonIgnoredModules.length, 0);
nonIgnoredModules.forEach((module) => {
  const editorRouter = new Router(editorList, module, modules, argValues.performance);
  editorRouter.parse(module);

  const decompilerRouter = new Router(decompilerList, module, modules, argValues.performance);
  decompilerRouter.parse(module);

  progressBar.increment();
});

progressBar.stop();
if (argValues.performance) {
  console.log(`Traversal took ${Router.traverseTimeTaken}ms`);
  console.log(Router.timeTaken);
}
console.log(`Took ${performance.now() - startTime}ms`);
startTime = performance.now();
console.log('Generating code...');
progressBar.start(nonIgnoredModules.length, 0);
const generatedFiles = nonIgnoredModules.map((module) => {
  const returnValue = {
    name: module.moduleId,
    code: generator({
      ...module.originalFile.program,
      type: 'Program',
      body: module.moduleCode.body,
    }).code,
  };
  progressBar.increment();
  return returnValue;
});

progressBar.stop();
console.log(`Took ${performance.now() - startTime}ms`);
startTime = performance.now();
console.log('Saving...');
progressBar.start(nonIgnoredModules.length, 0);

generatedFiles.forEach((file) => {
  const filePath = `${argValues.out}/${file.name}.js`;
  if (!fsExtra.existsSync(filePath) || fsExtra.readFileSync(filePath, 'utf-8') !== file.code) {
    fsExtra.writeFileSync(`${argValues.out}/${file.name}.js`, file.code);
  }
  progressBar.increment();
});

progressBar.stop();

if (argValues.entry && !argValues.agressiveCache) {
  console.log('Writing to cache...');
  new CacheParse(inputJsFile, '').writeCache(cacheFileName, modules);
}

console.log(`Took ${performance.now() - startTime}ms`);
startTime = performance.now();
if (!argValues.noEslint) {
  console.log('Doing further cleanup with ESLint...');
  (async function main() {
    const eslint = new ESLint({
      fix: true,
      ignore: false,
      useEslintrc: false,
      overrideConfig: eslintConfig,
    });

    const results = await eslint.lintFiles([`${argValues.out}/*.js`]);

    await ESLint.outputFixes(results);
  }()).then(() => {
    console.log(`Took ${performance.now() - startTime}ms`);
    startTime = performance.now();
    console.log('Done!');
  }).catch((error) => {
    console.error(error);
  });
} else {
  console.log('Done!');
}
