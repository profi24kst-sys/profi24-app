import {tmpdir} from 'node:os';
import path from 'node:path';

// Regression tests execute production document routes. Never let them write to
// the production default /data/uploads or require privileged filesystem access.
process.env.UPLOAD_DIR ||= path.join(tmpdir(),`profi24-crm-regression-${process.pid}`);
