import ModuleFinder from './moduleFinder';

export default class BabelModuleFinder extends ModuleFinder {
  evaluate(): void {
    const arraySpreadRegex = /{var .=.\(.\[0]\),.=.\(.\[1]\),.=.\(.\[2]\),.=.\(.\[3]\);.\.exports=function\(.\){return .\(.\)\|\|.\(.\)\|\|.\(.\)\|\|.\(\);};}/;
    if (arraySpreadRegex.test(this.module.originalCode)) {
      this.tagAsNpmModule('@babel/runtime/helpers/toConsumableArray');
    }
  }
}