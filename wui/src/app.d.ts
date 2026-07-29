declare global {
  namespace App {
    interface PageData {
      buildInfo?: {
        version: string;
        buildHash: string;
      };
    }
  }
}

export {};
