export class TFile {
  extension: string;
  constructor(public path = "") {
    this.extension = path.split(".").pop() ?? "";
  }
}

export class TFolder {
  constructor(public children: (TFile | TFolder)[] = []) {}
}
