import { readFile, readdir } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';

export type TechCategory =
  | 'framework'
  | 'db'
  | 'orm'
  | 'testing'
  | 'pdf'
  | 'graphics'
  | 'search'
  | 'queue'
  | 'api'
  | 'css'
  | 'state'
  | 'build'
  | 'auth'
  | 'logging'
  | 'http'
  | 'other';

export type ManifestKind =
  | 'npm'
  | 'composer'
  | 'gradle'
  | 'maven'
  | 'pyproject'
  | 'requirements'
  | 'pipfile'
  | 'cargo'
  | 'go'
  | 'gem'
  | 'mix';

export interface TechItem {
  /** Canonical lowercase slug — also used to derive `<name>-specialist` agent id. */
  name: string;
  displayName: string;
  category: TechCategory;
  /** Manifest files where this dep was found (e.g. ["package.json", "build.gradle"]). */
  manifests: string[];
  /** Raw dep keys that matched (e.g. ["org.lwjgl.lwjgl:lwjgl", "next"]). */
  matchedKeys: string[];
  /** Number of source files referencing this tech via import grep. Capped at 100. */
  fileCount: number;
}

export interface TechInventory {
  items: TechItem[];
  scannedManifests: string[];
}

interface CatalogEntry {
  name: string;
  displayName: string;
  category: TechCategory;
  /** Per-manifest dep matchers. `*` is a wildcard segment. */
  deps: Partial<Record<ManifestKind, string[]>>;
  /** Source-file scan: extensions to scan, regex to count usage. */
  imports: { exts: string[]; pattern: RegExp }[];
}

/* ------------------------------------------------------------------ */
/* Catalog                                                             */
/* ------------------------------------------------------------------ */

const JAVA_EXT = ['.java', '.kt', '.kts', '.scala', '.groovy'];
const JS_EXT = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'];
const PHP_EXT = ['.php', '.module', '.inc', '.install', '.theme'];
const PY_EXT = ['.py'];
const RB_EXT = ['.rb'];

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function jsImport(pkg: string): RegExp {
  return new RegExp(`(?:from|require\\()\\s*['"]${escapeRe(pkg)}(?:['"/])`);
}
function pyImport(pkg: string): RegExp {
  return new RegExp(
    `(?:^|\\n)\\s*(?:from\\s+${escapeRe(pkg)}|import\\s+${escapeRe(pkg)})(?:[\\s.,]|$)`,
  );
}
function javaImport(pkgPrefix: string): RegExp {
  return new RegExp(`import\\s+${escapeRe(pkgPrefix)}\\.`);
}
function phpUse(nsOrSymbol: string): RegExp {
  const e = escapeRe(nsOrSymbol);
  return new RegExp(`(?:^|\\s)(?:use\\s+${e}|new\\s+${e}|${e}::)`);
}
function rubyRequire(name: string): RegExp {
  return new RegExp(`require\\s+['"]${escapeRe(name)}['"]`);
}

const CATALOG: CatalogEntry[] = [
  /* Frameworks (web/app) */
  {
    name: 'next',
    displayName: 'Next.js',
    category: 'framework',
    deps: { npm: ['next'] },
    imports: [{ exts: JS_EXT, pattern: jsImport('next') }],
  },
  {
    name: 'react',
    displayName: 'React',
    category: 'framework',
    deps: { npm: ['react'] },
    imports: [{ exts: JS_EXT, pattern: jsImport('react') }],
  },
  {
    name: 'vue',
    displayName: 'Vue',
    category: 'framework',
    deps: { npm: ['vue'] },
    imports: [{ exts: [...JS_EXT, '.vue'], pattern: jsImport('vue') }],
  },
  {
    name: 'angular',
    displayName: 'Angular',
    category: 'framework',
    deps: { npm: ['@angular/core'] },
    imports: [{ exts: JS_EXT, pattern: jsImport('@angular/core') }],
  },
  {
    name: 'svelte',
    displayName: 'Svelte',
    category: 'framework',
    deps: { npm: ['svelte'] },
    imports: [{ exts: [...JS_EXT, '.svelte'], pattern: jsImport('svelte') }],
  },
  {
    name: 'nestjs',
    displayName: 'NestJS',
    category: 'framework',
    deps: { npm: ['@nestjs/core'] },
    imports: [{ exts: JS_EXT, pattern: jsImport('@nestjs/common') }],
  },
  {
    name: 'express',
    displayName: 'Express',
    category: 'framework',
    deps: { npm: ['express'] },
    imports: [{ exts: JS_EXT, pattern: jsImport('express') }],
  },
  {
    name: 'fastify',
    displayName: 'Fastify',
    category: 'framework',
    deps: { npm: ['fastify'] },
    imports: [{ exts: JS_EXT, pattern: jsImport('fastify') }],
  },
  {
    name: 'hono',
    displayName: 'Hono',
    category: 'framework',
    deps: { npm: ['hono'] },
    imports: [{ exts: JS_EXT, pattern: jsImport('hono') }],
  },
  {
    name: 'django',
    displayName: 'Django',
    category: 'framework',
    deps: { pyproject: ['django', 'Django'], requirements: ['django', 'Django'] },
    imports: [{ exts: PY_EXT, pattern: pyImport('django') }],
  },
  {
    name: 'flask',
    displayName: 'Flask',
    category: 'framework',
    deps: { pyproject: ['flask', 'Flask'], requirements: ['flask', 'Flask'] },
    imports: [{ exts: PY_EXT, pattern: pyImport('flask') }],
  },
  {
    name: 'fastapi',
    displayName: 'FastAPI',
    category: 'framework',
    deps: { pyproject: ['fastapi'], requirements: ['fastapi'] },
    imports: [{ exts: PY_EXT, pattern: pyImport('fastapi') }],
  },
  {
    name: 'rails',
    displayName: 'Rails',
    category: 'framework',
    deps: { gem: ['rails'] },
    imports: [{ exts: RB_EXT, pattern: rubyRequire('rails') }],
  },
  {
    name: 'spring-boot',
    displayName: 'Spring Boot',
    category: 'framework',
    deps: {
      gradle: ['org.springframework.boot:*'],
      maven: ['org.springframework.boot:*'],
    },
    imports: [{ exts: JAVA_EXT, pattern: javaImport('org.springframework.boot') }],
  },
  {
    name: 'spring-framework',
    displayName: 'Spring Framework',
    category: 'framework',
    deps: {
      gradle: ['org.springframework:*'],
      maven: ['org.springframework:*'],
    },
    imports: [{ exts: JAVA_EXT, pattern: javaImport('org.springframework') }],
  },
  {
    name: 'drupal-7',
    displayName: 'Drupal 7',
    category: 'framework',
    deps: { composer: ['drupal/drupal'] },
    imports: [{ exts: PHP_EXT, pattern: /\bhook_(?:menu|init|boot|form_alter|node_)/i }],
  },
  {
    name: 'drupal',
    displayName: 'Drupal',
    category: 'framework',
    deps: { composer: ['drupal/core', 'drupal/core-recommended'] },
    imports: [{ exts: PHP_EXT, pattern: /\bDrupal\\\\|namespace\s+Drupal\\/i }],
  },
  {
    name: 'laravel',
    displayName: 'Laravel',
    category: 'framework',
    deps: { composer: ['laravel/framework'] },
    imports: [{ exts: PHP_EXT, pattern: phpUse('Illuminate') }],
  },
  {
    name: 'symfony',
    displayName: 'Symfony',
    category: 'framework',
    deps: { composer: ['symfony/symfony', 'symfony/framework-bundle'] },
    imports: [{ exts: PHP_EXT, pattern: phpUse('Symfony') }],
  },

  /* Databases */
  {
    name: 'postgresql',
    displayName: 'PostgreSQL',
    category: 'db',
    deps: {
      npm: ['pg', 'postgres'],
      pyproject: ['psycopg2', 'psycopg2-binary', 'asyncpg', 'psycopg'],
      requirements: ['psycopg2', 'psycopg2-binary', 'asyncpg', 'psycopg'],
      gradle: ['org.postgresql:postgresql'],
      maven: ['org.postgresql:postgresql'],
      cargo: ['postgres', 'tokio-postgres'],
      gem: ['pg'],
    },
    imports: [
      { exts: JS_EXT, pattern: /(?:from|require\()\s*['"](?:pg|postgres)['"]/ },
      { exts: PY_EXT, pattern: /(?:^|\n)\s*(?:from|import)\s+(?:psycopg2?|asyncpg)\b/ },
      { exts: JAVA_EXT, pattern: /import\s+org\.postgresql\.|jdbc:postgresql:/i },
      { exts: PHP_EXT, pattern: /pg_(?:connect|query|fetch_)|PDO\([^)]*pgsql/ },
      { exts: RB_EXT, pattern: /\bPG\.|require\s+['"]pg['"]/ },
    ],
  },
  {
    name: 'mysql',
    displayName: 'MySQL/MariaDB',
    category: 'db',
    deps: {
      npm: ['mysql', 'mysql2', 'mariadb'],
      pyproject: ['pymysql', 'mysqlclient', 'mariadb'],
      requirements: ['pymysql', 'mysqlclient', 'mariadb'],
      gradle: ['mysql:mysql-connector-java', 'org.mariadb.jdbc:mariadb-java-client'],
      maven: ['mysql:mysql-connector-java', 'org.mariadb.jdbc:mariadb-java-client'],
      gem: ['mysql2'],
    },
    imports: [
      { exts: JS_EXT, pattern: /(?:from|require\()\s*['"]mysql2?['"]/ },
      { exts: PY_EXT, pattern: /(?:^|\n)\s*(?:from|import)\s+(?:pymysql|MySQLdb|mariadb)\b/ },
      { exts: PHP_EXT, pattern: /mysqli?_(?:connect|query|fetch_)|PDO\([^)]*mysql/ },
    ],
  },
  {
    name: 'sqlite',
    displayName: 'SQLite',
    category: 'db',
    deps: {
      npm: ['sqlite3', 'better-sqlite3'],
      gradle: ['org.xerial:sqlite-jdbc'],
      maven: ['org.xerial:sqlite-jdbc'],
    },
    imports: [{ exts: JS_EXT, pattern: /(?:from|require\()\s*['"](?:better-)?sqlite3['"]/ }],
  },
  {
    name: 'mongodb',
    displayName: 'MongoDB',
    category: 'db',
    deps: {
      npm: ['mongodb', 'mongoose'],
      pyproject: ['pymongo', 'motor'],
      requirements: ['pymongo', 'motor'],
    },
    imports: [
      { exts: JS_EXT, pattern: /(?:from|require\()\s*['"](?:mongodb|mongoose)['"]/ },
      { exts: PY_EXT, pattern: /(?:^|\n)\s*(?:from|import)\s+(?:pymongo|motor)\b/ },
    ],
  },
  {
    name: 'redis',
    displayName: 'Redis',
    category: 'db',
    deps: {
      npm: ['redis', 'ioredis'],
      pyproject: ['redis'],
      requirements: ['redis'],
      gem: ['redis'],
    },
    imports: [
      { exts: JS_EXT, pattern: /(?:from|require\()\s*['"](?:redis|ioredis)['"]/ },
      { exts: PY_EXT, pattern: /(?:^|\n)\s*(?:from|import)\s+redis\b/ },
    ],
  },

  /* ORM */
  {
    name: 'prisma',
    displayName: 'Prisma',
    category: 'orm',
    deps: { npm: ['prisma', '@prisma/client'] },
    imports: [{ exts: JS_EXT, pattern: jsImport('@prisma/client') }],
  },
  {
    name: 'drizzle-orm',
    displayName: 'Drizzle ORM',
    category: 'orm',
    deps: { npm: ['drizzle-orm'] },
    imports: [{ exts: JS_EXT, pattern: jsImport('drizzle-orm') }],
  },
  {
    name: 'typeorm',
    displayName: 'TypeORM',
    category: 'orm',
    deps: { npm: ['typeorm'] },
    imports: [{ exts: JS_EXT, pattern: jsImport('typeorm') }],
  },
  {
    name: 'sequelize',
    displayName: 'Sequelize',
    category: 'orm',
    deps: { npm: ['sequelize'] },
    imports: [{ exts: JS_EXT, pattern: jsImport('sequelize') }],
  },
  {
    name: 'sqlalchemy',
    displayName: 'SQLAlchemy',
    category: 'orm',
    deps: { pyproject: ['sqlalchemy', 'SQLAlchemy'], requirements: ['sqlalchemy', 'SQLAlchemy'] },
    imports: [{ exts: PY_EXT, pattern: pyImport('sqlalchemy') }],
  },
  {
    name: 'hibernate',
    displayName: 'Hibernate',
    category: 'orm',
    deps: { gradle: ['org.hibernate:*'], maven: ['org.hibernate:*'] },
    imports: [{ exts: JAVA_EXT, pattern: javaImport('org.hibernate') }],
  },

  /* Testing */
  {
    name: 'playwright',
    displayName: 'Playwright',
    category: 'testing',
    deps: { npm: ['@playwright/test', 'playwright'], pyproject: ['playwright'] },
    imports: [{ exts: JS_EXT, pattern: jsImport('@playwright/test') }],
  },
  {
    name: 'jest',
    displayName: 'Jest',
    category: 'testing',
    deps: { npm: ['jest'] },
    imports: [{ exts: JS_EXT, pattern: /\b(?:describe|test|it|expect)\(|\bjest\.mock\(/ }],
  },
  {
    name: 'vitest',
    displayName: 'Vitest',
    category: 'testing',
    deps: { npm: ['vitest'] },
    imports: [{ exts: JS_EXT, pattern: jsImport('vitest') }],
  },
  {
    name: 'cypress',
    displayName: 'Cypress',
    category: 'testing',
    deps: { npm: ['cypress'] },
    imports: [{ exts: JS_EXT, pattern: /cy\.(?:visit|get|contains|wait)\(/ }],
  },
  {
    name: 'pytest',
    displayName: 'pytest',
    category: 'testing',
    deps: { pyproject: ['pytest'], requirements: ['pytest'] },
    imports: [{ exts: PY_EXT, pattern: /(?:^|\n)\s*(?:import|from)\s+pytest\b/ }],
  },
  {
    name: 'phpunit',
    displayName: 'PHPUnit',
    category: 'testing',
    deps: { composer: ['phpunit/phpunit'] },
    imports: [{ exts: PHP_EXT, pattern: phpUse('PHPUnit') }],
  },
  {
    name: 'junit',
    displayName: 'JUnit',
    category: 'testing',
    deps: {
      gradle: ['junit:junit', 'org.junit.jupiter:*', 'org.junit:*'],
      maven: ['junit:junit', 'org.junit.jupiter:*', 'org.junit:*'],
    },
    imports: [{ exts: JAVA_EXT, pattern: javaImport('org.junit') }],
  },

  /* PDF */
  {
    name: 'tcpdf',
    displayName: 'TCPDF',
    category: 'pdf',
    deps: { composer: ['tecnickcom/tcpdf', 'tcpdf/tcpdf'] },
    imports: [{ exts: PHP_EXT, pattern: /\bnew\s+TCPDF\b|\bTCPDF::|\bTCPDF\s*\(/ }],
  },
  {
    name: 'dompdf',
    displayName: 'Dompdf',
    category: 'pdf',
    deps: { composer: ['dompdf/dompdf'] },
    imports: [{ exts: PHP_EXT, pattern: phpUse('Dompdf') }],
  },
  {
    name: 'puppeteer',
    displayName: 'Puppeteer',
    category: 'pdf',
    deps: { npm: ['puppeteer', 'puppeteer-core'] },
    imports: [{ exts: JS_EXT, pattern: jsImport('puppeteer') }],
  },
  {
    name: 'jspdf',
    displayName: 'jsPDF',
    category: 'pdf',
    deps: { npm: ['jspdf'] },
    imports: [{ exts: JS_EXT, pattern: jsImport('jspdf') }],
  },
  {
    name: 'reportlab',
    displayName: 'ReportLab',
    category: 'pdf',
    deps: { pyproject: ['reportlab'], requirements: ['reportlab'] },
    imports: [{ exts: PY_EXT, pattern: pyImport('reportlab') }],
  },
  {
    name: 'itext',
    displayName: 'iText',
    category: 'pdf',
    deps: {
      gradle: ['com.itextpdf:*'],
      maven: ['com.itextpdf:*'],
    },
    imports: [{ exts: JAVA_EXT, pattern: javaImport('com.itextpdf') }],
  },

  /* Graphics / games */
  {
    name: 'lwjgl2',
    displayName: 'LWJGL 2',
    category: 'graphics',
    deps: {
      gradle: ['org.lwjgl.lwjgl:*'],
      maven: ['org.lwjgl.lwjgl:*'],
    },
    imports: [{ exts: JAVA_EXT, pattern: javaImport('org.lwjgl') }],
  },
  {
    name: 'lwjgl3',
    displayName: 'LWJGL 3',
    category: 'graphics',
    deps: {
      gradle: ['org.lwjgl:lwjgl', 'org.lwjgl:lwjgl-*'],
      maven: ['org.lwjgl:lwjgl', 'org.lwjgl:lwjgl-*'],
    },
    imports: [{ exts: JAVA_EXT, pattern: javaImport('org.lwjgl') }],
  },
  {
    name: 'libgdx',
    displayName: 'libGDX',
    category: 'graphics',
    deps: {
      gradle: ['com.badlogicgames.gdx:*'],
      maven: ['com.badlogicgames.gdx:*'],
    },
    imports: [{ exts: JAVA_EXT, pattern: javaImport('com.badlogic.gdx') }],
  },
  {
    name: 'jogamp',
    displayName: 'JogAmp / JOGL',
    category: 'graphics',
    deps: {
      gradle: ['org.jogamp.jogl:*', 'org.jogamp.gluegen:*'],
      maven: ['org.jogamp.jogl:*', 'org.jogamp.gluegen:*'],
    },
    imports: [{ exts: JAVA_EXT, pattern: javaImport('com.jogamp') }],
  },
  {
    name: 'three',
    displayName: 'three.js',
    category: 'graphics',
    deps: { npm: ['three'] },
    imports: [{ exts: JS_EXT, pattern: jsImport('three') }],
  },

  /* Search */
  {
    name: 'elasticsearch',
    displayName: 'Elasticsearch',
    category: 'search',
    deps: {
      npm: ['@elastic/elasticsearch', 'elasticsearch'],
      pyproject: ['elasticsearch'],
      requirements: ['elasticsearch'],
      gradle: ['org.elasticsearch.client:*'],
      maven: ['org.elasticsearch.client:*'],
    },
    imports: [{ exts: JS_EXT, pattern: jsImport('@elastic/elasticsearch') }],
  },
  {
    name: 'meilisearch',
    displayName: 'Meilisearch',
    category: 'search',
    deps: { npm: ['meilisearch'] },
    imports: [{ exts: JS_EXT, pattern: jsImport('meilisearch') }],
  },
  {
    name: 'solr',
    displayName: 'Apache Solr',
    category: 'search',
    deps: { composer: ['solarium/solarium'] },
    imports: [{ exts: PHP_EXT, pattern: phpUse('Solarium') }],
  },

  /* Queue */
  {
    name: 'bullmq',
    displayName: 'BullMQ',
    category: 'queue',
    deps: { npm: ['bullmq', 'bull'] },
    imports: [{ exts: JS_EXT, pattern: jsImport('bullmq') }],
  },
  {
    name: 'celery',
    displayName: 'Celery',
    category: 'queue',
    deps: { pyproject: ['celery'], requirements: ['celery'] },
    imports: [{ exts: PY_EXT, pattern: pyImport('celery') }],
  },
  {
    name: 'sidekiq',
    displayName: 'Sidekiq',
    category: 'queue',
    deps: { gem: ['sidekiq'] },
    imports: [{ exts: RB_EXT, pattern: rubyRequire('sidekiq') }],
  },
  {
    name: 'kafka',
    displayName: 'Kafka',
    category: 'queue',
    deps: {
      npm: ['kafkajs'],
      gradle: ['org.apache.kafka:*'],
      maven: ['org.apache.kafka:*'],
    },
    imports: [{ exts: JS_EXT, pattern: jsImport('kafkajs') }],
  },
  {
    name: 'rabbitmq',
    displayName: 'RabbitMQ',
    category: 'queue',
    deps: { npm: ['amqplib'], pyproject: ['pika'], requirements: ['pika'] },
    imports: [{ exts: JS_EXT, pattern: jsImport('amqplib') }],
  },

  /* API patterns */
  {
    name: 'graphql',
    displayName: 'GraphQL',
    category: 'api',
    deps: { npm: ['graphql', 'apollo-server', '@apollo/client', '@apollo/server'] },
    imports: [{ exts: JS_EXT, pattern: jsImport('graphql') }],
  },
  {
    name: 'trpc',
    displayName: 'tRPC',
    category: 'api',
    deps: { npm: ['@trpc/server', '@trpc/client'] },
    imports: [{ exts: JS_EXT, pattern: jsImport('@trpc/server') }],
  },
  {
    name: 'openapi',
    displayName: 'OpenAPI / Swagger',
    category: 'api',
    deps: {
      npm: ['swagger-jsdoc', '@apidevtools/swagger-parser', 'openapi-types'],
      pyproject: ['drf-yasg', 'apispec'],
    },
    imports: [{ exts: JS_EXT, pattern: jsImport('swagger-jsdoc') }],
  },
  {
    name: 'axios',
    displayName: 'axios',
    category: 'http',
    deps: { npm: ['axios'] },
    imports: [{ exts: JS_EXT, pattern: jsImport('axios') }],
  },
  {
    name: 'retrofit',
    displayName: 'Retrofit',
    category: 'http',
    deps: { gradle: ['com.squareup.retrofit2:*'], maven: ['com.squareup.retrofit2:*'] },
    imports: [{ exts: JAVA_EXT, pattern: javaImport('retrofit2') }],
  },

  /* CSS frameworks */
  {
    name: 'tailwindcss',
    displayName: 'Tailwind CSS',
    category: 'css',
    deps: { npm: ['tailwindcss'] },
    imports: [{ exts: ['.css'], pattern: /@tailwind\s+(?:base|components|utilities)/ }],
  },
  {
    name: 'bootstrap',
    displayName: 'Bootstrap',
    category: 'css',
    deps: { npm: ['bootstrap'] },
    imports: [{ exts: JS_EXT, pattern: jsImport('bootstrap') }],
  },
  {
    name: 'chakra-ui',
    displayName: 'Chakra UI',
    category: 'css',
    deps: { npm: ['@chakra-ui/react'] },
    imports: [{ exts: JS_EXT, pattern: jsImport('@chakra-ui/react') }],
  },
  {
    name: 'mui',
    displayName: 'Material UI',
    category: 'css',
    deps: { npm: ['@mui/material'] },
    imports: [{ exts: JS_EXT, pattern: jsImport('@mui/material') }],
  },

  /* State management */
  {
    name: 'redux',
    displayName: 'Redux',
    category: 'state',
    deps: { npm: ['redux', '@reduxjs/toolkit'] },
    imports: [{ exts: JS_EXT, pattern: jsImport('@reduxjs/toolkit') }],
  },
  {
    name: 'zustand',
    displayName: 'Zustand',
    category: 'state',
    deps: { npm: ['zustand'] },
    imports: [{ exts: JS_EXT, pattern: jsImport('zustand') }],
  },
  {
    name: 'mobx',
    displayName: 'MobX',
    category: 'state',
    deps: { npm: ['mobx'] },
    imports: [{ exts: JS_EXT, pattern: jsImport('mobx') }],
  },

  /* Build tooling */
  {
    name: 'gradle',
    displayName: 'Gradle',
    category: 'build',
    deps: { gradle: ['*:*'] },
    imports: [{ exts: ['.gradle', '.kts'], pattern: /\bplugins\s*\{|\bdependencies\s*\{/ }],
  },
  {
    name: 'maven',
    displayName: 'Maven',
    category: 'build',
    deps: { maven: ['*:*'] },
    imports: [{ exts: ['.xml'], pattern: /<modelVersion>4\.0\.0<\/modelVersion>/ }],
  },
  {
    name: 'webpack',
    displayName: 'Webpack',
    category: 'build',
    deps: { npm: ['webpack'] },
    imports: [{ exts: JS_EXT, pattern: jsImport('webpack') }],
  },
  {
    name: 'vite',
    displayName: 'Vite',
    category: 'build',
    deps: { npm: ['vite'] },
    imports: [{ exts: JS_EXT, pattern: jsImport('vite') }],
  },

  /* Auth */
  {
    name: 'next-auth',
    displayName: 'NextAuth',
    category: 'auth',
    deps: { npm: ['next-auth', '@auth/core'] },
    imports: [{ exts: JS_EXT, pattern: jsImport('next-auth') }],
  },
  {
    name: 'passport',
    displayName: 'Passport',
    category: 'auth',
    deps: { npm: ['passport'] },
    imports: [{ exts: JS_EXT, pattern: jsImport('passport') }],
  },

  /* Logging */
  {
    name: 'pino',
    displayName: 'pino',
    category: 'logging',
    deps: { npm: ['pino'] },
    imports: [{ exts: JS_EXT, pattern: jsImport('pino') }],
  },
  {
    name: 'winston',
    displayName: 'winston',
    category: 'logging',
    deps: { npm: ['winston'] },
    imports: [{ exts: JS_EXT, pattern: jsImport('winston') }],
  },
  {
    name: 'log4j',
    displayName: 'Log4j',
    category: 'logging',
    deps: {
      gradle: ['org.apache.logging.log4j:*'],
      maven: ['org.apache.logging.log4j:*'],
    },
    imports: [{ exts: JAVA_EXT, pattern: javaImport('org.apache.logging.log4j') }],
  },
  {
    name: 'slf4j',
    displayName: 'SLF4J',
    category: 'logging',
    deps: { gradle: ['org.slf4j:*'], maven: ['org.slf4j:*'] },
    imports: [{ exts: JAVA_EXT, pattern: javaImport('org.slf4j') }],
  },
];

/* ------------------------------------------------------------------ */
/* Manifest parsers                                                    */
/* ------------------------------------------------------------------ */

interface ParsedDep {
  manifest: string;
  kind: ManifestKind;
  /** For npm/composer/gem/cargo/pyproject/requirements: package name.
   *  For gradle/maven: `group:artifact`. For go: import path prefix. */
  key: string;
  version: string | null;
}

async function readTextSafe(p: string): Promise<string | null> {
  try {
    return await readFile(p, 'utf8');
  } catch {
    return null;
  }
}

async function parsePackageJson(repoPath: string, file = 'package.json'): Promise<ParsedDep[]> {
  const txt = await readTextSafe(path.join(repoPath, file));
  if (!txt) return [];
  try {
    const obj = JSON.parse(txt) as Record<string, unknown>;
    const deps = obj.dependencies as Record<string, string> | undefined;
    const devDeps = obj.devDependencies as Record<string, string> | undefined;
    const peer = obj.peerDependencies as Record<string, string> | undefined;
    const merged = { ...(deps ?? {}), ...(devDeps ?? {}), ...(peer ?? {}) };
    return Object.entries(merged).map(([key, version]) => ({
      manifest: file,
      kind: 'npm' as const,
      key,
      version: typeof version === 'string' ? version : null,
    }));
  } catch {
    return [];
  }
}

async function parseComposerJson(repoPath: string): Promise<ParsedDep[]> {
  const txt = await readTextSafe(path.join(repoPath, 'composer.json'));
  if (!txt) return [];
  try {
    const obj = JSON.parse(txt) as Record<string, unknown>;
    const req = obj.require as Record<string, string> | undefined;
    const reqDev = obj['require-dev'] as Record<string, string> | undefined;
    const merged = { ...(req ?? {}), ...(reqDev ?? {}) };
    return Object.entries(merged)
      .filter(([k]) => k !== 'php')
      .map(([key, version]) => ({
        manifest: 'composer.json',
        kind: 'composer' as const,
        key,
        version: typeof version === 'string' ? version : null,
      }));
  } catch {
    return [];
  }
}

async function parseGradle(repoPath: string): Promise<ParsedDep[]> {
  const out: ParsedDep[] = [];
  for (const file of ['build.gradle', 'build.gradle.kts']) {
    const txt = await readTextSafe(path.join(repoPath, file));
    if (!txt) continue;
    /* Synthetic marker so the gradle catalog `*:*` always matches even when
       a project declares deps via `fileTree(...)` / version catalogs / Spring
       BOMs that this regex parser can't extract. Build.gradle present = a
       Gradle build is in play. */
    out.push({ manifest: file, kind: 'gradle', key: '__build_system__:gradle', version: null });
    /* `implementation 'group:artifact:version'` (also api/compile/runtimeOnly/test*).
       group1 must not contain colons or it greedy-eats group:artifact together. */
    const shortRe =
      /\b(?:implementation|api|compile|runtimeOnly|compileOnly|testImplementation|testCompile|testRuntime|annotationProcessor|kapt|ksp)\s*\(?\s*['"]([^'":\s]+):([^'":\s]+)(?::([^'"\s]+))?['"]/g;
    for (const m of txt.matchAll(shortRe)) {
      const [, group, artifact, version] = m;
      if (!group || !artifact) continue;
      out.push({
        manifest: file,
        kind: 'gradle',
        key: `${group}:${artifact}`,
        version: version ?? null,
      });
    }
    /* Map syntax: `api group: 'g', name: 'a', version: 'v'` */
    const mapRe =
      /\b(?:implementation|api|compile|runtimeOnly|compileOnly|testImplementation|testCompile|testRuntime)\s+group\s*:\s*['"]([^'"]+)['"]\s*,\s*name\s*:\s*['"]([^'"]+)['"](?:\s*,\s*version\s*:\s*['"]([^'"]+)['"])?/g;
    for (const m of txt.matchAll(mapRe)) {
      const [, group, artifact, version] = m;
      if (!group || !artifact) continue;
      out.push({
        manifest: file,
        kind: 'gradle',
        key: `${group}:${artifact}`,
        version: version ?? null,
      });
    }
  }
  return out;
}

async function parsePomXml(repoPath: string): Promise<ParsedDep[]> {
  const txt = await readTextSafe(path.join(repoPath, 'pom.xml'));
  if (!txt) return [];
  const out: ParsedDep[] = [];
  /* Synthetic marker so the maven catalog `*:*` always matches even when
     a pom.xml uses dependencyManagement / BOM imports / property-substituted
     versions that don't fit our naive `<dependency>` extractor. */
  out.push({ manifest: 'pom.xml', kind: 'maven', key: '__build_system__:maven', version: null });
  const depBlockRe = /<dependency>([\s\S]*?)<\/dependency>/g;
  for (const m of txt.matchAll(depBlockRe)) {
    const body = m[1] ?? '';
    const groupId = body.match(/<groupId>\s*([^<]+?)\s*<\/groupId>/)?.[1];
    const artifactId = body.match(/<artifactId>\s*([^<]+?)\s*<\/artifactId>/)?.[1];
    const version = body.match(/<version>\s*([^<]+?)\s*<\/version>/)?.[1];
    if (!groupId || !artifactId) continue;
    out.push({
      manifest: 'pom.xml',
      kind: 'maven',
      key: `${groupId}:${artifactId}`,
      version: version ?? null,
    });
  }
  return out;
}

async function parsePyproject(repoPath: string): Promise<ParsedDep[]> {
  const txt = await readTextSafe(path.join(repoPath, 'pyproject.toml'));
  if (!txt) return [];
  const out: ParsedDep[] = [];
  /* PEP 621 array form */
  const arrayMatch = txt.match(/^\s*dependencies\s*=\s*\[([\s\S]*?)\]/m);
  if (arrayMatch?.[1]) {
    for (const line of arrayMatch[1].split('\n')) {
      const t = line.trim().replace(/^,/, '').replace(/,$/, '');
      const inner = t.match(/^['"]([^'"]+)['"]/)?.[1];
      if (!inner) continue;
      const name = inner.split(/[<>=!~\s\[]/)[0]?.trim();
      if (!name) continue;
      out.push({ manifest: 'pyproject.toml', kind: 'pyproject', key: name, version: null });
    }
  }
  /* Poetry table form */
  const poetryRe = /\[tool\.poetry\.(?:dev-)?dependencies\]\s*([\s\S]*?)(?=^\[|$)/gm;
  for (const pm of txt.matchAll(poetryRe)) {
    const body = pm[1] ?? '';
    for (const line of body.split('\n')) {
      const m2 = line.match(/^\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*=/);
      if (!m2 || !m2[1] || m2[1] === 'python') continue;
      out.push({ manifest: 'pyproject.toml', kind: 'pyproject', key: m2[1], version: null });
    }
  }
  return out;
}

async function parseRequirementsTxt(repoPath: string): Promise<ParsedDep[]> {
  const txt = await readTextSafe(path.join(repoPath, 'requirements.txt'));
  if (!txt) return [];
  const out: ParsedDep[] = [];
  for (const line of txt.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('-')) continue;
    const name = trimmed.split(/[<>=!~\s\[;]/)[0]?.trim();
    if (!name) continue;
    out.push({ manifest: 'requirements.txt', kind: 'requirements', key: name, version: null });
  }
  return out;
}

async function parseCargoToml(repoPath: string): Promise<ParsedDep[]> {
  const txt = await readTextSafe(path.join(repoPath, 'Cargo.toml'));
  if (!txt) return [];
  const out: ParsedDep[] = [];
  const tableRe = /\[(?:dev-|build-)?dependencies\]\s*([\s\S]*?)(?=^\[|$)/gm;
  for (const m of txt.matchAll(tableRe)) {
    const body = m[1] ?? '';
    for (const line of body.split('\n')) {
      const lm = line.match(/^\s*([A-Za-z0-9_-]+)\s*=/);
      if (!lm || !lm[1]) continue;
      out.push({ manifest: 'Cargo.toml', kind: 'cargo', key: lm[1], version: null });
    }
  }
  return out;
}

async function parseGoMod(repoPath: string): Promise<ParsedDep[]> {
  const txt = await readTextSafe(path.join(repoPath, 'go.mod'));
  if (!txt) return [];
  const out: ParsedDep[] = [];
  /* `require ( ... )` block */
  const blockRe = /require\s*\(([\s\S]*?)\)/g;
  for (const m of txt.matchAll(blockRe)) {
    const body = m[1] ?? '';
    for (const line of body.split('\n')) {
      const lm = line.trim().match(/^([^\s]+)\s+v[^\s]+/);
      if (!lm || !lm[1]) continue;
      out.push({ manifest: 'go.mod', kind: 'go', key: lm[1], version: null });
    }
  }
  /* Single-line form */
  const singleRe = /^require\s+([^\s]+)\s+v[^\s]+/gm;
  for (const m of txt.matchAll(singleRe)) {
    if (!m[1]) continue;
    out.push({ manifest: 'go.mod', kind: 'go', key: m[1], version: null });
  }
  return out;
}

async function parseGemfile(repoPath: string): Promise<ParsedDep[]> {
  const txt = await readTextSafe(path.join(repoPath, 'Gemfile'));
  if (!txt) return [];
  const out: ParsedDep[] = [];
  const re = /^\s*gem\s+['"]([^'"]+)['"]/gm;
  for (const m of txt.matchAll(re)) {
    if (!m[1]) continue;
    out.push({ manifest: 'Gemfile', kind: 'gem', key: m[1], version: null });
  }
  return out;
}

async function parseMixExs(repoPath: string): Promise<ParsedDep[]> {
  const txt = await readTextSafe(path.join(repoPath, 'mix.exs'));
  if (!txt) return [];
  const out: ParsedDep[] = [];
  const re = /\{\s*:([a-z_][a-z0-9_]*)\s*,/g;
  for (const m of txt.matchAll(re)) {
    if (!m[1]) continue;
    out.push({ manifest: 'mix.exs', kind: 'mix', key: m[1], version: null });
  }
  return out;
}

async function collectAllDeps(
  repoPath: string,
): Promise<{ deps: ParsedDep[]; manifests: string[] }> {
  const results = await Promise.all([
    parsePackageJson(repoPath),
    parseComposerJson(repoPath),
    parseGradle(repoPath),
    parsePomXml(repoPath),
    parsePyproject(repoPath),
    parseRequirementsTxt(repoPath),
    parseCargoToml(repoPath),
    parseGoMod(repoPath),
    parseGemfile(repoPath),
    parseMixExs(repoPath),
  ]);
  const deps = results.flat();
  const manifests = Array.from(new Set(deps.map((d) => d.manifest)));
  return { deps, manifests };
}

/* ------------------------------------------------------------------ */
/* Source file walk + import counting                                  */
/* ------------------------------------------------------------------ */

const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  'vendor',
  '__pycache__',
  '.next',
  'dist',
  'build',
  '.ddev',
  'target',
  'out',
  '.gradle',
  '.idea',
  '.vscode',
]);

async function walkSourceFiles(
  repoPath: string,
  rel: string,
  depth: number,
  maxDepth: number,
  filesByExt: Map<string, string[]>,
): Promise<void> {
  if (depth > maxDepth) return;
  let entries: Dirent[];
  try {
    entries = (await readdir(path.join(repoPath, rel), { withFileTypes: true })) as Dirent[];
  } catch {
    return;
  }
  for (const e of entries) {
    if (IGNORE_DIRS.has(e.name)) continue;
    const childRel = rel ? path.join(rel, e.name) : e.name;
    if (e.isDirectory()) {
      await walkSourceFiles(repoPath, childRel, depth + 1, maxDepth, filesByExt);
    } else if (e.isFile()) {
      const dot = e.name.lastIndexOf('.');
      if (dot < 0) continue;
      const ext = e.name.slice(dot).toLowerCase();
      let arr = filesByExt.get(ext);
      if (!arr) {
        arr = [];
        filesByExt.set(ext, arr);
      }
      arr.push(childRel);
    }
  }
}

/** Scan source files once, score every catalog entry's import patterns
 *  against each candidate file. Each tech tracks its own seen-file set so
 *  a single file matching multiple techs is counted under each. Capped
 *  at 100 matches per tech. */
async function countAllTechMatches(
  repoPath: string,
  filesByExt: Map<string, string[]>,
  cap = 100,
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const seenByTech = new Map<string, Set<string>>();
  const patternsByExt = new Map<string, { name: string; pattern: RegExp }[]>();
  for (const entry of CATALOG) {
    seenByTech.set(entry.name, new Set());
    for (const imp of entry.imports) {
      for (const ext of imp.exts) {
        const e = ext.toLowerCase();
        let arr = patternsByExt.get(e);
        if (!arr) {
          arr = [];
          patternsByExt.set(e, arr);
        }
        arr.push({ name: entry.name, pattern: imp.pattern });
      }
    }
  }
  for (const [ext, patterns] of patternsByExt) {
    const files = filesByExt.get(ext);
    if (!files) continue;
    for (const rel of files) {
      const text = await readTextSafe(path.join(repoPath, rel));
      if (text === null) continue;
      const slice = text.length > 64 * 1024 ? text.slice(0, 64 * 1024) : text;
      for (const { name, pattern } of patterns) {
        const seen = seenByTech.get(name);
        if (!seen || seen.has(rel)) continue;
        const cur = counts.get(name) ?? 0;
        if (cur >= cap) continue;
        if (pattern.test(slice)) {
          counts.set(name, cur + 1);
          seen.add(rel);
        }
      }
    }
  }
  return counts;
}

/* ------------------------------------------------------------------ */
/* Catalog matching                                                    */
/* ------------------------------------------------------------------ */

function matchesKey(parsedKey: string, catalogKey: string): boolean {
  if (parsedKey === catalogKey) return true;
  if (catalogKey === '*:*') return parsedKey.includes(':');
  if (!catalogKey.includes('*')) return false;
  const escaped = catalogKey
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\\\*/g, '\\*')
    .replace(/\*/g, '[^:]+');
  return new RegExp(`^${escaped}$`).test(parsedKey);
}

function findCatalogMatches(
  deps: ParsedDep[],
): Map<string, { entry: CatalogEntry; manifests: Set<string>; matchedKeys: Set<string> }> {
  const out = new Map<
    string,
    { entry: CatalogEntry; manifests: Set<string>; matchedKeys: Set<string> }
  >();
  for (const dep of deps) {
    for (const entry of CATALOG) {
      const candidates = entry.deps[dep.kind];
      if (!candidates) continue;
      const hit = candidates.some((c) => matchesKey(dep.key, c));
      if (!hit) continue;
      let bucket = out.get(entry.name);
      if (!bucket) {
        bucket = { entry, manifests: new Set(), matchedKeys: new Set() };
        out.set(entry.name, bucket);
      }
      bucket.manifests.add(dep.manifest);
      bucket.matchedKeys.add(dep.key);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/* Lowered from 5 to 2 so small/medium repos (e.g. a 7-file Java project that
   uses LWJGL across 2 files) don't drop out of inventory. The catalog only
   covers well-known significant techs, so 2 imports is plausibly enough
   signal to warrant a specialist agent. */
const FILE_COUNT_THRESHOLD = 2;

export interface BuildTechInventoryOptions {
  /** Override file-count threshold. Defaults to 5. */
  threshold?: number;
  /** Override directory walk depth. Defaults to 6. */
  maxDepth?: number;
}

export async function buildTechInventory(
  repoPath: string,
  options: BuildTechInventoryOptions = {},
): Promise<TechInventory> {
  const threshold = options.threshold ?? FILE_COUNT_THRESHOLD;
  const maxDepth = options.maxDepth ?? 6;

  const { deps, manifests } = await collectAllDeps(repoPath);
  const matches = findCatalogMatches(deps);

  const filesByExt = new Map<string, string[]>();
  await walkSourceFiles(repoPath, '', 0, maxDepth, filesByExt);
  const counts = await countAllTechMatches(repoPath, filesByExt);

  const items: TechItem[] = [];
  for (const entry of CATALOG) {
    const matchInfo = matches.get(entry.name);
    const fileCount = counts.get(entry.name) ?? 0;
    const hasManifest = matchInfo !== undefined;
    /* framework + build: surface-level signals, manifest match alone is enough.
       Everything else: only surface when actual usage clears the threshold. */
    const isToplevel = entry.category === 'framework' || entry.category === 'build';
    const passes = isToplevel ? hasManifest || fileCount >= threshold : fileCount >= threshold;
    if (!passes) continue;
    items.push({
      name: entry.name,
      displayName: entry.displayName,
      category: entry.category,
      manifests: matchInfo ? Array.from(matchInfo.manifests) : [],
      matchedKeys: matchInfo ? Array.from(matchInfo.matchedKeys) : [],
      fileCount,
    });
  }

  items.sort((a, b) => {
    if (a.category !== b.category) return a.category.localeCompare(b.category);
    return b.fileCount - a.fileCount;
  });

  return { items, scannedManifests: manifests };
}

/** Render the inventory as a Markdown table for inclusion in LLM prompts. */
export function renderTechInventoryTable(inv: TechInventory): string {
  if (inv.items.length === 0) {
    return '(no significant secondary technologies detected)';
  }
  const lines: string[] = [];
  lines.push('| Technology | Category | Files | Manifests | Suggested agent id |');
  lines.push('|---|---|---|---|---|');
  for (const it of inv.items) {
    const manifestList = it.manifests.join(', ');
    lines.push(
      `| ${it.displayName} | ${it.category} | ${it.fileCount} | ${manifestList} | ${it.name}-specialist |`,
    );
  }
  return lines.join('\n');
}
