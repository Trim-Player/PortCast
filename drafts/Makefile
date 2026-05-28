DRAFT = draft-trimplayer-portcast-00

.PHONY: all xml txt html clean check

all: txt html

xml: $(DRAFT).xml
txt: $(DRAFT).txt
html: $(DRAFT).html

$(DRAFT).xml: $(DRAFT).md
	kramdown-rfc $< > $@

$(DRAFT).txt: $(DRAFT).xml
	xml2rfc --text $<

$(DRAFT).html: $(DRAFT).xml
	xml2rfc --html $<

check: $(DRAFT).xml
	idnits $(DRAFT).txt || true

clean:
	rm -f $(DRAFT).xml $(DRAFT).txt $(DRAFT).html
