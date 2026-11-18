/**
 * Side-effect entry for `node --import`.
 * Must load before any module that imports `node:sqlite`.
 */
import { installSqliteWarningFilter } from './warnings.js';

installSqliteWarningFilter();
