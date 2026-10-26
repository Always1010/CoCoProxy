#!/usr/bin/env node
import { buildReleaseMain } from './build-release.mjs';

await buildReleaseMain(true);
