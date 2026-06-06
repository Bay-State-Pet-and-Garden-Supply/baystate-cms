import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

export class GitClient {
  private gitDir: string;

  constructor(private repoPath: string) {
    this.gitDir = path.join(repoPath, '.git');
  }

  get repoDir(): string {
    return this.repoPath;
  }

  isInstalled(): boolean {
    try {
      execFileSync('git', ['--version'], { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }

  isRepo(): boolean {
    return fs.existsSync(this.gitDir);
  }

  init(): string {
    const output = execFileSync('git', ['init', '-b', 'main'], { cwd: this.repoPath, encoding: 'utf-8' });
    this.ensureConfig('user.name', 'ShopSite CMS');
    this.ensureConfig('user.email', 'cms@shopsite.local');
    return output.trim();
  }

  add(paths: string[]): void {
    execFileSync('git', ['add', '--', ...paths], {
      cwd: this.repoPath,
      stdio: 'pipe',
    });
  }

  commit(message: string): string {
    const output = execFileSync('git', ['commit', '-m', message], {
      cwd: this.repoPath,
      encoding: 'utf-8',
    });
    return output.trim();
  }

  getHeadHash(): string {
    try {
      return execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: this.repoPath,
        encoding: 'utf-8',
      }).trim();
    } catch {
      return '';
    }
  }

  status(): string {
    return execFileSync('git', ['status', '--short'], {
      cwd: this.repoPath,
      encoding: 'utf-8',
    }).trim();
  }

  readFileAtHead(filePath: string): string | null {
    try {
      return execFileSync('git', ['show', `HEAD:${filePath}`], {
        cwd: this.repoPath,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      return null;
    }
  }

  private ensureConfig(key: string, value: string): void {
    try {
      execFileSync('git', ['config', key], {
        cwd: this.repoPath,
        stdio: 'pipe',
      });
    } catch {
      execFileSync('git', ['config', key, value], {
        cwd: this.repoPath,
        stdio: 'pipe',
      });
    }
  }
}
