import Dexie, { type Table } from 'dexie';

export interface ProjectRecord {
  id: string;
  name: string;
  lastModified: number;
}

export interface ProjectDataRecord {
  projectId: string;
  storeSnapshot: string; // JSON serialized store state
}

export class GTFSDatabase extends Dexie {
  projects!: Table<ProjectRecord>;
  projectData!: Table<ProjectDataRecord>;

  constructor() {
    super('gtfs-builder');
    this.version(1).stores({
      projects: 'id',
      projectData: 'projectId',
    });
  }
}

export const db = new GTFSDatabase();
