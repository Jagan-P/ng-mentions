import {
  AfterViewInit,
  ChangeDetectorRef,
  Component,
  ComponentFactoryResolver,
  ContentChild,
  Directive,
  ElementRef,
  EventEmitter,
  HostListener,
  Input,
  NgZone,
  OnChanges,
  OnDestroy,
  OnInit,
  Output,
  SimpleChanges,
  TemplateRef,
  ViewChild,
  ViewContainerRef,
  ViewEncapsulation
} from '@angular/core';
import {Subject} from 'rxjs';

import {MentionsListComponent} from './mentions-list.component';
import {
  applyChangeToValue,
  escapeRegExp,
  findStartOfMentionInPlainText,
  getBoundsOfMentionAtPosition,
  getCaretPosition,
  mapPlainTextIndex,
  MarkupMention,
  markupToRegExp,
  replacePlaceholders,
  setCaretPosition,
  styleProperties
} from './utils';
import {Key} from "./key";

interface Tag {
  indices: {start: number, end: number};
}

interface Line {
  originalContent: string;
  content: string;
  parts: Array<string|Mention>;
}

interface Mention {
  contents: string;
  tag: Tag;
}

@Directive({selector: 'highlighted'})
export class HighlightedDirective {
  @Input() tag: Tag;
}

/**
 *
 */
@Component({
  moduleId: module.id,
  exportAs: 'ngxMentions',
  selector: 'ngx-mentions',
  template: `
      <div #highlighter class="highlighter" [ngClass]="textAreaClassNames" [attr.readonly]="readonly"
           [ngStyle]="highlighterStyle">
          <div *ngFor="let line of lines">
              <ng-container *ngFor="let part of line.parts">
                  <highlighted *ngIf="isPartMention(part)" [tag]="part.tag">{{formatMention(part)}}</highlighted>
                  <ng-container *ngIf="!isPartMention(part)">{{part}}</ng-container>
              </ng-container>
              &nbsp;
          </div>
      </div>
      <textarea
        #input
        [rows]="rows"
        [cols]="columns"
        [ngModel]="displayContent"
        [ngClass]="textAreaClassNames"
        (keydown)="onKeyDown($event)"
        (blur)="onBlur($event)"
        (select)="onSelect($event)"
        (mouseup)="onSelect($event)"
        (ngModelChange)="onChange($event)"
        (scroll)="onTextAreaScroll()"
        [disabled]="disabled"
        [required]="required"
        [placeholder]="placeholder"
      ></textarea>
  `,
  styles: [
    'ngx-mentions {position: relative;}',
    'ngx-mentions textarea {position:relative; background-color: transparent !important;}',
    `ngx-mentions .highlighter {
        position: absolute;
        top:      0;
        left:     0;
        right:    0;
        bottom:   0;
        color:    transparent;
        overflow: hidden !important;
    }`,
    `ngx-mentions highlighted {
        display:          inline;
        border-radius:    3px;
        padding:          1px;
        margin:           -1px;
        overflow-wrap:    break-word;
        background-color: lightblue;
    }`
  ],
  preserveWhitespaces: false,
  encapsulation: ViewEncapsulation.None
})
export class NgxMentionsComponent implements OnChanges, OnInit, AfterViewInit, OnDestroy {
  /**
   * The character to trigger the mentions list when a user is typing in the input field
   */
  @Input('triggerChar') triggerChar: string = '@';
  /**
   * The markup used to format a mention in the model value
   */
  @Input('markup') mentionMarkup: string = '@[__display__](__type__:__id__)';
  /**
   * Optional. When using a custom search (i.e. an API call), the internal searching capability should be disabled.
   */
  @Input('disableSearch') disableSearch: boolean = false;
  /**
   * Only used when internal search is not disabled. This limits the maximum number of items to display in the search
   * result list.
   */
  @Input('maxItems') maxItems: number = -1;
  /**
   * Used to cause the search result list to display in a "drop up" fashion, instead of a typical dropdown.
   */
  @Input('dropUp') dropUp: boolean = false;
  /**
   * If the supplied mentions are a list of objects, this is the name of the property used to display
   * the mention in the search result list and when formatting a mention in the displayed text.
   */
  @Input('displayName') displayName: string = 'display';
  /**
   * Classes for textarea
   */
  @Input('formClass')
  get formClass(): string {
    return Object.keys(this.textAreaClassNames).join(' ');
  }

  set formClass(classNames: string) {
    this.textAreaClassNames = {};
    Array.from(classNames.split(' ')).forEach(className => {
      this.textAreaClassNames[className] = true;
    });
  }

  @Input('placeholder') placeholder: string;
  @Input('value')
  get value(): string {
    return this._value;
  }

  set value(value: string) {
    this.parseLines(value);
  }

  @Input('required')
  get required(): boolean {
    return this._required;
  }

  set required(value: boolean) {
    this._required = value;
    this.updateStylesAndProperties();
  }

  @Input('disabled')
  get disabled(): boolean {
    return this._disabled;
  }

  set disabled(value: boolean) {
    this._disabled = value;
    this.updateStylesAndProperties();
  }

  @Input('rows')
  get rows(): any {
    return this._rows;
  }

  set rows(value: any) {
    this._rows = <number>value;
    this.updateStylesAndProperties();
  }

  @Input('cols')
  get columns(): any {
    return this._columns;
  }

  set columns(value: any) {
    this._columns = <number>value;
    this.updateStylesAndProperties();
  }

  /**
   * The list of mentions to display, or filter, in the search result list.
   */
  @Input('mentions')
  set mentionItems(value: any[]) {
    this.mentions = value;
    if (this.disableSearch && this.mentionsList) {
      this.mentionsList.items = value;
    }
  }

  /**
   * An event emitted, after the trigger character has been typed, with the user-entered search string.
   */
  @Output('search') readonly search: EventEmitter<string> = new EventEmitter<string>();
  @Output('valueChanges') readonly valueChanges: EventEmitter<string> = new EventEmitter<string>();
  @Output('stateChanges') readonly stateChanges: Subject<void> = new Subject<void>();

  @ContentChild(TemplateRef) mentionListTemplate: TemplateRef<any>;
  @ViewChild('input') textAreaInputElement: ElementRef;
  @ViewChild('highlighter') highlighterElement: ElementRef;

  displayContent: string = '';
  lines: Line[] = [];
  highlighterStyle: {[key: string]: string} = {};
  textAreaClassNames: {[key: string]: boolean} = {};
  selectionStart: number;
  selectionEnd: number;
  mentions: any[] = [];

  get readonly(): string {
    return this.disabled ? 'readonly' : null;
  }

  get errorState(): boolean {
    return this._errorState;
  }

  private _value: string = '';
  private _required: boolean;
  private _disabled: boolean;
  private _rows: number;
  private _columns: number;
  private searchString: string;
  private startPos: number;
  private startNode;
   mentionsList: MentionsListComponent;
  private stopSearch: boolean = false;
  private markupSearch: MarkupMention;
  private _destroyed: Subject<void> = new Subject<void>();
  private newLine: RegExp = /\n/g;
  private _errorState: boolean = false;

  constructor(
      private element: ElementRef, private componentResolver: ComponentFactoryResolver,
      private viewContainer: ViewContainerRef, private changeDetector: ChangeDetectorRef, private ngZone: NgZone) {}

  ngOnInit(): void {
    this.parseMarkup();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if ('markup' in changes) {
      this.parseMarkup();
    }
  }

  ngAfterViewInit(): void {
    this.parseLines(this._value);
    this.updateStylesAndProperties();
  }

  ngOnDestroy(): void {
    this._destroyed.next();
    this._destroyed.complete();
  }

  @HostListener('window:resize')
  public onWindowResize() {
    this.refreshStyles();
  }

  public onTextAreaScroll() {
    this.highlighterElement.nativeElement.scrollTop = this.textAreaInputElement.nativeElement.scrollTop;
  }

  public onSelect(event: any) {
    this.selectionStart = event.target.selectionStart;
    this.selectionEnd = event.target.selectionEnd;
  }

  public onChange(newPlainTextValue: string) {
    let value = this._value;
    let displayTransform = this.displayTransform.bind(this);
    let selectionStart = this.textAreaInputElement.nativeElement.selectionStart;
    let selectionEnd = this.textAreaInputElement.nativeElement.selectionEnd;
    let bounds = getBoundsOfMentionAtPosition(newPlainTextValue, this.markupSearch, selectionStart, displayTransform);
    if (bounds.start !== -1) {
      newPlainTextValue = newPlainTextValue.substring(0, bounds.start) + newPlainTextValue.substring(bounds.end);
    }
    let newValue = applyChangeToValue(
        value, this.markupSearch, newPlainTextValue, this.selectionStart, this.selectionEnd, selectionEnd,
        displayTransform);
    let startOfMention = findStartOfMentionInPlainText(value, this.markupSearch, selectionStart, displayTransform);
    if (startOfMention.start > -1 && this.selectionEnd > startOfMention.start) {
      selectionStart = startOfMention.start;
      selectionEnd = selectionStart;
    }
    this.selectionStart = Math.max(selectionStart, 0);
    this.selectionEnd = Math.max(selectionEnd, 0);
    this.parseLines(newValue);
    if (this.selectionEnd > 0) {
      setTimeout(() => setCaretPosition(this.textAreaInputElement.nativeElement, this.selectionEnd));
    }
  }

  public onKeyDown(event: any) {
    let caretPosition: number = getCaretPosition(this.textAreaInputElement.nativeElement);
    let characterPressed = event.key;
    let keyCode = event.which || event.keyCode;
    if (!characterPressed) {
      let characterCode = event.which || keyCode;
      characterPressed = String.fromCharCode(characterCode);
      if (!event.shiftKey && (characterCode >= 65 && characterCode <= 90)) {
        characterPressed = String.fromCharCode(characterCode + 32);
      }
    }

    if (keyCode === Key.Enter && event.wasSelection && caretPosition < this.startPos) {
      caretPosition = this.startNode.length;
      setCaretPosition(this.startNode, caretPosition);
    }

    let startOfMention =
        findStartOfMentionInPlainText(this._value, this.markupSearch, caretPosition, this.displayTransform.bind(this));
    if (characterPressed === this.triggerChar) {
      this.setupMentionsList(caretPosition);
    } else if (startOfMention.start === -1 && this.startPos >= 0) {
      if (caretPosition <= this.startPos) {
        this.mentionsList.show = false;
        this.startPos = -1;
      } else if (
          keyCode !== Key.Shift && !event.metaKey && !event.altKey && !event.ctrlKey &&
          caretPosition > this.startPos) {
        this.handleKeyDown(event, caretPosition, characterPressed);
      }
    } else {
      this.onSelect({target: this.textAreaInputElement.nativeElement});
    }
  }

  public onBlur(event: MouseEvent|KeyboardEvent) {
    this.stopEvent(event);
    if (this.mentionsList) {
      this.mentionsList.show = false;
    }
  }

  public isPartMention(part: any): boolean {
    return typeof part.contents !== 'undefined';
  }

  public formatMention(mention: Mention): string {
    return this._formatMention(mention.contents);
  }

  private displayTransform(..._: string[]): string {
    let replaceIndex = this.markupSearch.groups[this.displayName];
    return _[replaceIndex];
  }

  private _formatMention(contents: string): string {
    let replaceValue = `\$${this.displayName}`, replaceIndex;
    let result = contents.replace(this.markupSearch.regEx, `\$${this.displayName}`);
    if (result === replaceValue) {
      replaceIndex = `\$${this.markupSearch.groups[this.displayName]}`;
      result = contents.replace(this.markupSearch.regEx, replaceIndex);
    }

    return result;
  }

  private stopEvent(event: MouseEvent|KeyboardEvent) {
    if (event.preventDefault) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    }
  }

  private setupMentionsList(caretPosition: number) {
    this.startPos = caretPosition;
    this.startNode = window.getSelection().anchorNode;
    this.searchString = '';
    this.stopSearch = false;
    this.showMentionsList();
    this.updateMentionsList();
  }

  private handleKeyDown(event: any, caretPosition: number, characterPressed: string) {
    let keyCode = event.which || event.keyCode;
    if (keyCode === Key.Space) {
      this.startPos = -1;
    } else if (keyCode === Key.Backspace && caretPosition > 0) {
      caretPosition--;
      if (caretPosition === this.startPos) {
        this.stopSearch = true;
      }
      this.mentionsList.show = !this.stopSearch;
    } else if (this.mentionsList.show) {
      if (keyCode === Key.Tab || keyCode === Key.Enter) {
        this.stopEvent(event);
        this.mentionsList.show = false;
        let value = this._value;
        let start = mapPlainTextIndex(value, this.markupSearch, this.startPos, false, this.displayTransform.bind(this));
        let item = event.item || this.mentionsList.selectedItem;
        let newValue = replacePlaceholders(item, this.markupSearch);
        let newDisplayValue = this._formatMention(newValue);
        caretPosition = this.startPos + newDisplayValue.length;
        let searchString = this.searchString || '';
        value = value.substring(0, start) + newValue + value.substring(start + searchString.length + 1, value.length);
        this.parseLines(value);
        this.startPos = -1;
        this.searchString = '';
        this.stopSearch = true;
        this.changeDetector.detectChanges();
        setTimeout(() => {
          setCaretPosition(this.textAreaInputElement.nativeElement, caretPosition);
          this.onSelect({target: this.textAreaInputElement.nativeElement});
        });
        return;
      } else if (keyCode === Key.Escape) {
        this.stopEvent(event);
        this.mentionsList.show = false;
        this.stopSearch = true;
        return;
      } else if (keyCode === Key.ArrowDown) {
        this.stopEvent(event);
        this.mentionsList.selectNextItem();
        return;
      } else if (keyCode === Key.ArrowUp) {
        this.stopEvent(event);
        this.mentionsList.selectPreviousItem();
        return;
      } else if (keyCode === Key.Home) {
        this.stopEvent(event);
        this.mentionsList.selectFirstItem();
        return;
      } else if (keyCode === Key.End) {
        this.stopEvent(event);
        this.mentionsList.selectLastItem();
        return;
      }
    }

    if (keyCode === Key.ArrowLeft ||
      keyCode === Key.ArrowRight ||
      keyCode === Key.Home ||
      keyCode === Key.End) {
      this.onSelect(event);
      return;
    }

    let mention = this.displayContent.substring(this.startPos + 1, caretPosition);
    if (keyCode !== Key.Backspace) {
      mention += characterPressed;
    }
    this.searchString = mention || '';
    this.updateMentionsList();
  }

  private getDisplayValue(item: any): string {
    if (typeof item === 'string') {
      return item;
    } else if (item[this.displayName] !== undefined) {
      return item[this.displayName];
    }

    return null;
  }

  private showMentionsList() {
    if (!this.mentionsList) {
      let componentFactory = this.componentResolver.resolveComponentFactory(MentionsListComponent);
      let componentRef = this.viewContainer.createComponent(componentFactory);
      this.mentionsList = componentRef.instance;
      this.mentionsList.itemTemplate = this.mentionListTemplate;
      this.mentionsList.displayTransform = this.displayTransform.bind(this);
      this.mentionsList.itemSelected.subscribe(item => {
        this.textAreaInputElement.nativeElement.focus();
        const fakeEvent = {keyCode: Key.Enter, wasSelection: true, item: item};
        this.onKeyDown(fakeEvent);
      });
      this.mentionsList.displayTransform = this.getDisplayValue.bind(this);
    }
    this.mentionsList.show = true;
    this.mentionsList.dropUp = this.dropUp;
    this.mentionsList.activeIndex = 0;
    this.mentionsList.position(this.textAreaInputElement.nativeElement);
    this.ngZone.run(() => this.mentionsList.resetScroll());
  }

  private updateMentionsList() {
    if (!this.disableSearch) {
      let items = Array.from(this.mentions);
      if (this.searchString) {
        let searchString = this.searchString.toLowerCase(), searchRegEx = new RegExp(escapeRegExp(searchString), 'i');
        items = items.filter(item => {
          let value = this.getDisplayValue(item);
          return value !== null && searchRegEx.test(value);
        });
        if (this.maxItems > 0) {
          items = items.slice(0, this.maxItems);
        }
      }

      this.mentionsList.items = items;
    } else {
      this.search.emit(this.searchString);
    }
  }

  private parseMarkup() {
    if (this.mentionMarkup.length === 0 || this.mentionMarkup[0] !== this.triggerChar) {
      throw new Error(`ngx-mentions markup pattern must start with the trigger character "${this.triggerChar}"`);
    }

    this.markupSearch = markupToRegExp(this.mentionMarkup);
  }

  private parseLines(value: string = '') {
    if (value !== this._value) {
      value = value || '';
      let lines = value.split(this.newLine).map((line: string) => this.formatMentions(line));
      let displayContent = lines.map(line => line.content).join('\n');
      if (this.displayContent !== displayContent) {
        this.lines = lines;
        this.displayContent = displayContent;
        this.triggerChange(value);
      }
    }
  }

  private formatMentions(line: string): Line {
    let lineObj: Line = <Line>{originalContent: line, content: line, parts: []};

    if (line.length === 0) {
      return lineObj;
    }

    let tags: Tag[] = [], mention;
    let regEx = this.markupSearch.regEx;
    regEx.lastIndex = 0;
    while (mention = regEx.exec(line)) {
      tags.push({indices: {start: mention.index, end: mention.index + mention[0].length}});
    }

    let prevTags: Tag[] = [];
    let content = '';
    [...tags].sort((tagA, tagB) => tagA.indices.start - tagB.indices.start).forEach((tag: Tag) => {
      const expectedLength = tag.indices.end - tag.indices.start;
      const contents = line.slice(tag.indices.start, tag.indices.end);
      if (contents.length === expectedLength) {
        const prevIndex = prevTags.length > 0 ? prevTags[prevTags.length - 1].indices.end : 0;
        const before = line.slice(prevIndex, tag.indices.start);
        const partMention = <Mention>{contents: contents, tag: tag};
        lineObj.parts.push(before);
        lineObj.parts.push(partMention);
        prevTags.push(tag);
        content += before + this.formatMention(partMention);
      }
    });

    const remainingStart = prevTags.length > 0 ? prevTags[prevTags.length - 1].indices.end : 0;
    const remaining = line.slice(remainingStart);
    lineObj.parts.push(remaining);
    content += remaining;
    lineObj.content = content;

    return lineObj;
  }

  private refreshStyles() {
    let element = this.textAreaInputElement.nativeElement;
    let computedStyle: any = getComputedStyle(element);
    this.highlighterStyle = {};
    styleProperties.forEach(prop => {
      this.highlighterStyle[prop] = computedStyle[prop];
    });
    this.changeDetector.detectChanges();
  }

  private updateStylesAndProperties() {
    this.refreshStyles();
  }

  private triggerChange(value: string) {
    this._value = value;
    this.valueChanges.emit(this._value);
    this.changeDetector.detectChanges();
  }
}
